import { app, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { directorySize } from './updateDownload'
import { removeAutoStartTask } from './autostart'
import { currentAppVersion } from './appVersion'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { psQuote, runPowerShell } from './powershell'
import { log } from './logger'
import { directoriesOverlap } from '@shared/paths'
import { realDirectoryPath } from './dataDir'
import { createSiblingWorkspace, isFileSystemRoot } from './directoryPath'

/**
 * Install / uninstall of the launcher itself.
 *
 * A *per-user* installation (`%LOCALAPPDATA%\Programs\KevinLauncher` by default)
 * that Windows recognises: the uninstall entry lives in
 * `HKCU\...\Uninstall\KevinLauncher`, so it shows up in Windows Settings → Apps
 * and can be removed from there (the UninstallString runs the same exe with
 * `--uninstall`, which opens the self-drawn uninstall UI).
 *
 * User data always lives in `%APPDATA%\kevin-launcher` and is never inside the
 * install directory, so an overwrite install cannot lose anything.
 */

const exec = promisify(execFile)

const UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KevinLauncher'
const UNINSTALL_KEY_MACHINE =
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KevinLauncher'
const APP_KEY = 'HKCU\\Software\\KevinLauncher'
/** Marker file inside the install directory (also used for stale-file cleanup). */
const INFO_FILE = 'install.json'
const EXE = 'KevinLauncher.exe'

export interface InstallInfo {
  version: string
  installedAt: string
  /** Every installed file, relative to the install directory (`/` separated). */
  files: string[]
}

export interface DetectedInstall {
  dir: string
  version: string | null
  /**
   * Where the location came from: the uninstall registry entry, the default
   * path, or a **currently running** launcher (which is not necessarily
   * installed — e.g. running from a build directory).
   */
  source: 'registry' | 'default' | 'running'
}

export interface InstallTarget {
  dir: string
  exists: boolean
  /** True when the directory already holds a KevinLauncher installation. */
  isInstalled: boolean
  version: string | null
  /** Files currently in the directory (0 for a fresh/empty path). */
  fileCount: number
}

export interface ApplyProgress {
  /** Bytes copied so far / total bytes to copy. */
  done: number
  total: number
  /** Relative path being written. */
  current: string
}

interface InstallLifecycle {
  beforeStage: () => Promise<void>
  afterCommit: (freshInstall: boolean) => Promise<void>
}

// ------------------------------------------------------------------- helpers

export function defaultInstallDir(): string {
  const base = process.env.LOCALAPPDATA ?? app.getPath('home')
  return join(base, 'Programs', 'KevinLauncher')
}

const shortcuts = (): { startMenu: string; desktop: string } => ({
  startMenu: join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'KevinLauncher.lnk'
  ),
  desktop: join(app.getPath('desktop'), 'KevinLauncher.lnk')
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Recursively lists files, relative to `base` (`/` separated, sorted). */
export async function listFiles(base: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
    }
  }
  await walk(base)
  return out.sort()
}

async function regQuery(key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await exec('reg', ['query', key, '/v', value], { windowsHide: true })
    const match = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function regAdd(key: string, values: [string, string, string][]): Promise<void> {
  for (const [name, type, data] of values) {
    await exec('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'], {
      windowsHide: true
    })
  }
}

async function regDelete(key: string): Promise<void> {
  try {
    await exec('reg', ['delete', key, '/f'], { windowsHide: true })
  } catch {
    /* not present */
  }
}

// ------------------------------------------------------ install info / detect

export async function readInstallInfo(dir: string): Promise<InstallInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir, INFO_FILE), 'utf8')) as InstallInfo
    return Array.isArray(parsed.files) ? parsed : null
  } catch {
    return null
  }
}

async function writeInstallInfo(dir: string, version: string, files: string[]): Promise<void> {
  const info: InstallInfo = { version, installedAt: new Date().toISOString(), files }
  await writeFileAtomic(join(dir, INFO_FILE), JSON.stringify(info, null, 2))
}

/** Paths of every running KevinLauncher.exe that is not this process. */
export async function runningInstances(): Promise<string[]> {
  try {
    const stdout = await runPowerShell(
      'Get-Process KevinLauncher -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path'
    )
    const self = process.execPath.toLowerCase()
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().endsWith('.exe'))
      .filter((line) => line.toLowerCase() !== self)
  } catch {
    return []
  }
}

/** PIDs running the given executable (empty when the path cannot be read). */
async function pidsUsing(exe: string): Promise<number[]> {
  const target = psQuote(exe)
  try {
    const stdout = await runPowerShell(
      `Get-Process KevinLauncher -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Path -ieq ${target} } | Select-Object -ExpandProperty Id`
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

/** True when the executable can be opened for writing (i.e. not in use). */
async function isUnlocked(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'r+')
    await handle.close()
    return true
  } catch (error) {
    // A missing file cannot be locked either.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Closes the launcher **installed in `targetDir`** (best effort).
 *
 * Only processes running `<targetDir>\KevinLauncher.exe` are targeted — this is
 * what makes it safe: the installer itself runs from its own folder, so it can
 * never close itself (a previous "exclude my own path" filter did exactly that
 * when the paths did not compare equal).
 *
 * Returns true when the executable is no longer in use.
 */
export async function closeRunningInstances(targetDir: string): Promise<boolean> {
  const exe = join(targetDir, EXE)
  const pids = await pidsUsing(exe)
  if (pids.length) {
    log(`install: closing launcher instance(s) ${pids.join(', ')} at ${targetDir}`)
    try {
      await runPowerShell(`Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`)
    } catch {
      /* reported through the return value */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  // Opening the exe for writing is the reliable "still running?" probe — it does
  // not depend on being able to read process paths.
  return isUnlocked(exe)
}

function assertInstallTarget(dir: string): void {
  if (isFileSystemRoot(dir)) throw new Error('不能安装到磁盘或共享目录的根目录')
}

/**
 * Makes sure the launcher ends up in its own sub-directory: a chosen path that
 * is itself a drive root (or any folder not already named KevinLauncher) gets
 * `\KevinLauncher` appended, so nobody installs straight into `D:\`.
 */
export function normalizeInstallDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  if (!trimmed) return defaultInstallDir()
  // Drive root like "D:" / "D:\"
  if (/^[a-zA-Z]:$/.test(trimmed)) return join(trimmed + '\\', 'KevinLauncher')
  if (isFileSystemRoot(dir)) return join(dir, 'KevinLauncher')
  if (/(^|[\\/])KevinLauncher$/i.test(trimmed)) return trimmed
  return join(trimmed, 'KevinLauncher')
}

/**
 * The version actually installed in `dir`.
 *
 * `resources/app-version.txt` is authoritative: the installer and the in-app
 * upgrade both write it, while `install.json` / the registry entry are only
 * written by the installer and therefore go stale after an in-app update.
 */
export async function installedVersion(dir: string): Promise<string | null> {
  try {
    const version = (await fs.readFile(join(dir, 'resources', 'app-version.txt'), 'utf8')).trim()
    return version || null
  } catch {
    return null
  }
}

/**
 * Keeps the install marker and the uninstall entry in sync with the version that
 * is actually installed (after an in-app upgrade they would still name the
 * version that was installed by the setup).
 */
export async function syncInstalledVersion(installDir: string, version: string): Promise<void> {
  try {
    const info = await readInstallInfo(installDir)
    if (info && info.version !== version) {
      const updated: InstallInfo = { ...info, version }
      await writeFileAtomic(join(installDir, INFO_FILE), JSON.stringify(updated, null, 2))
    }
    const registered = await regQuery(UNINSTALL_KEY, 'DisplayVersion')
    if (registered && registered !== version) {
      await regAdd(UNINSTALL_KEY, [['DisplayVersion', 'REG_SZ', version]])
      await regAdd(APP_KEY, [['Version', 'REG_SZ', version]])
      log(`install: version entry updated to ${version}`)
    }
  } catch (error) {
    log(`install: could not sync the version entry (${(error as Error).message})`)
  }
}

/** Finds an existing installation (registry first, then the default path). */
export async function detectInstallation(): Promise<DetectedInstall | null> {
  for (const [key, source] of [
    [UNINSTALL_KEY, 'registry'],
    [UNINSTALL_KEY_MACHINE, 'registry']
  ] as const) {
    const dir = await regQuery(key, 'InstallLocation')
    if (dir && (await pathExists(join(dir, EXE)))) {
      return {
        dir,
        version: (await installedVersion(dir)) ?? (await regQuery(key, 'DisplayVersion')),
        source
      }
    }
  }
  const fallback = defaultInstallDir()
  if (await pathExists(join(fallback, EXE))) {
    return {
      dir: fallback,
      version: (await installedVersion(fallback)) ?? (await readInstallInfo(fallback))?.version ?? null,
      source: 'default'
    }
  }
  // A launcher that is running right now (e.g. straight from a build folder) is
  // still the most relevant target for an overwrite install.
  const running = await runningInstances()
  if (running.length) {
    const dir = dirname(running[0])
    return {
      dir,
      version: (await installedVersion(dir)) ?? (await readInstallInfo(dir))?.version ?? null,
      source: 'running'
    }
  }
  return null
}

/** Inspects a candidate install directory (used by the installer UI). */
export async function inspectTarget(dir: string): Promise<InstallTarget> {
  const exists = await pathExists(dir)
  const isInstalled = exists && (await pathExists(join(dir, EXE)))
  const info = isInstalled ? await readInstallInfo(dir) : null
  const files = exists && isInstalled ? await listFiles(dir) : []
  return {
    dir,
    exists,
    isInstalled,
    // The version pointer wins: it is updated by in-app upgrades too.
    version: isInstalled ? ((await installedVersion(dir)) ?? info?.version ?? null) : null,
    fileCount: files.length
  }
}

export async function installSize(): Promise<number> {
  // Size of the running build — in install mode that is the extracted payload.
  return directorySize(dirname(process.execPath))
}

/** Free bytes on the volume that holds `dir`. */
export async function freeSpace(dir: string): Promise<number> {
  const letter = /^([a-zA-Z]):/.exec(dir)?.[1]
  if (!letter) return 0
  try {
    const stdout = await runPowerShell(`(Get-PSDrive -Name ${letter}).Free`)
    return Number(stdout.trim()) || 0
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------- install

/** True when `dir` can be created/written by this process. */
export async function canWrite(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = join(dir, `.kevin-write-${Date.now()}`)
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}


/** `--install-dir <dir>` lets the elevated instance continue with the same target. */
export function installDirArgument(): string | null {
  const index = process.argv.indexOf('--install-dir')
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

/** True when `--install-dir` was passed (i.e. we are the elevated instance). */
export function hasInstallDirArgument(): boolean {
  return process.argv.includes('--install-dir')
}

/**
 * Files that were installed by the previous version but are not part of the new
 * one — they get removed on an overwrite install. Only paths recorded in
 * `install.json` are ever considered, so user data can never be affected.
 */
export function staleFiles(previous: string[], current: string[]): string[] {
  const keep = new Set(current)
  return previous.filter((file) => !keep.has(file) && file !== INFO_FILE)
}

const INSTALL_STAGING_PREFIX = '.kevin-install-'
const RETIRED_PREFIX = '.kevin-install-retired-'
const INSTALL_JOURNAL = 'transaction.json'

interface InstallJournal {
  target: string
  owner: number
  id: string
}

interface InstallLease {
  path: string
  journal: InstallJournal
}

async function installationDirectory(path: string): Promise<boolean> {
  const info = await fs.lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('安装目标必须是实体目录')
  return true
}

function installerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission failures cannot prove the installer has exited.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readInstallJournal(directory: string, target: string): Promise<InstallJournal | null> {
  if (!(await installationDirectory(directory))) return null
  const result = await loadJsonSafe<InstallJournal | null>(join(directory, INSTALL_JOURNAL), 1)
  if (result.status !== 'ok') return null
  const journal = result.value
  if (!journal || typeof journal.target !== 'string' ||
      journal.target.toLowerCase() !== target.toLowerCase() ||
      !Number.isSafeInteger(journal.owner) || journal.owner <= 0 ||
      typeof journal.id !== 'string' || !/^[0-9a-f-]{36}$/.test(journal.id)) return null
  return journal
}

function retiredPath(journal: InstallJournal): string {
  return join(dirname(journal.target), `${RETIRED_PREFIX}${journal.id}`)
}

/**
 * Publish a non-empty lease directory with one same-volume rename. Competing
 * installers either acquire the directory or observe a complete owner journal.
 */
async function claimInstall(target: string): Promise<InstallLease> {
  const path = `${target}.kevin-install`
  const candidate = await createSiblingWorkspace(target, INSTALL_STAGING_PREFIX)
  const journal = { target, owner: process.pid, id: randomUUID() }
  let releaseRaces = 0
  try {
    await writeFileAtomic(join(candidate, INSTALL_JOURNAL), JSON.stringify(journal))
    for (;;) {
      try {
        await fs.rename(candidate, path)
        return { path, journal }
      } catch (renameError) {
        if (!(await installationDirectory(path))) {
          const code = (renameError as NodeJS.ErrnoException).code
          if ((code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') && releaseRaces++ < 3) continue
          throw renameError
        }
        const existing = await readInstallJournal(path, target)
        if (!existing) {
          if (!(await installationDirectory(path))) continue
          throw new Error(`无法识别当前的安装事务: ${path}`)
        }
        if (installerRunning(existing.owner)) throw new Error('已在安装到该目录')
        // Re-read after checking liveness. If a second recovery races us, its
        // archived, non-empty slot prevents replacing that generation.
        if ((await readInstallJournal(path, target))?.id !== existing.id) continue
        try {
          await fs.rename(path, retiredPath(existing))
        } catch (recoveryError) {
          if ((await readInstallJournal(path, target))?.id === existing.id) throw recoveryError
        }
      }
    }
  } finally {
    await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function releaseInstall(lease: InstallLease, preserve: boolean): Promise<void> {
  const retired = retiredPath(lease.journal)
  try {
    await renameWithRetry(lease.path, retired)
    if (!preserve) await fs.rm(retired, { recursive: true, force: true })
  } catch (error) {
    log(`install: could not clean transaction ${lease.path}: ${String(error)}`)
  }
}

/** Find a saved tree without promoting an unverified tree into the live path. */
async function findInterruptedInstall(target: string): Promise<string | undefined> {
  const parent = dirname(target)
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RETIRED_PREFIX)) continue
    const transaction = join(parent, entry.name)
    const journal = await readInstallJournal(transaction, target)
    if (!journal || retiredPath(journal) !== transaction) continue
    const previous = join(transaction, 'previous')
    if (await installationDirectory(previous)) return previous
  }
  return undefined
}

/** Copy only unmanaged entries, preserving other files placed in this directory. */
async function preserveUnmanaged(
  target: string,
  staged: string,
  oldFiles: string[],
  newFiles: string[]
): Promise<void> {
  const managed = new Set(oldFiles.filter(file => typeof file === 'string').map(file => file.toLowerCase()))
  const replaced = new Set([INFO_FILE, ...newFiles].map(file => file.toLowerCase()))
  const requiredDirectories = new Set<string>()
  for (const file of replaced) {
    const parents = file.split('/')
    parents.pop()
    while (parents.length) {
      requiredDirectories.add(parents.join('/'))
      parents.pop()
    }
  }
  await fs.cp(target, staged, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async from => {
      const path = relative(target, from).split(sep).join('/').toLowerCase()
      if (!path) return true
      const info = await fs.lstat(from)
      if (replaced.has(path)) {
        if (info.isDirectory()) throw new Error(`安装文件与现有目录冲突: ${from}`)
        return false
      }
      if (requiredDirectories.has(path) && !info.isDirectory() && !managed.has(path)) {
        throw new Error(`安装目录与现有文件冲突: ${from}`)
      }
      return info.isDirectory() || !managed.has(path)
    }
  })
}

/**
 * Stage a complete installation next to the target on the same volume. Commit
 * only after the new layout has finished copying, leaving the previous
 * directory ready to restore if promotion fails.
 */
export async function applyPayload(
  sourceDir: string,
  targetDir: string,
  onProgress?: (progress: ApplyProgress) => void,
  lifecycle?: InstallLifecycle
): Promise<{ files: string[]; bytes: number }> {
  const requested = resolve(targetDir)
  assertInstallTarget(requested)
  await installationDirectory(requested)
  const target = await realDirectoryPath(requested)
  assertInstallTarget(target)
  const source = await fs.realpath(sourceDir)
  if (directoriesOverlap(source, target)) throw new Error('安装源与目标目录不能重叠')
  const lease = await claimInstall(target)
  let preserveRollback = false
  try {
    const version = currentAppVersion()
    const files = (await listFiles(source)).filter(file => file.toLowerCase() !== INFO_FILE)
    const pointer = 'resources/app-version.txt'
    const required = [
      EXE, pointer, 'resources/app/out/main/index.js', 'resources/app/loader.js',
      `resources/app-${version}/out/main/index.js`
    ]
    if (required.some(file => !files.includes(file)) ||
        (await fs.readFile(join(source, pointer), 'utf8')).trim() !== version) {
      throw new Error('安装源缺少所需的程序文件或版本指针不匹配')
    }
    const sizes = new Map<string, number>()
    let total = 0
    for (const file of files) {
      const size = (await fs.stat(join(source, file))).size
      sizes.set(file, size)
      total += size
    }

    const existing = await installationDirectory(target)
    const priorTree = existing ? target : await findInterruptedInstall(target)
    const freshInstall = !priorTree || !(await installedVersion(priorTree))
    await lifecycle?.beforeStage()
    const previous = priorTree ? await readInstallInfo(priorTree) : null
    const staged = join(lease.path, 'next')
    const rollback = join(lease.path, 'previous')
    if (priorTree) await preserveUnmanaged(priorTree, staged, previous?.files ?? [], files)

    let done = 0
    let lastReport = 0
    for (const file of files) {
      const to = join(staged, file)
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.copyFile(join(source, file), to)
      const expected = sizes.get(file)!
      if ((await fs.stat(to)).size !== expected) throw new Error(`安装文件复制不完整: ${file}`)
      done += expected
      const now = Date.now()
      if (onProgress && (now - lastReport > 60 || done === total)) {
        lastReport = now
        onProgress({ done, total, current: file })
      }
    }
    await writeInstallInfo(staged, version, files)

    if (existing) await renameWithRetry(target, rollback)
    try {
      await renameWithRetry(staged, target)
    } catch (error) {
      if (existing) {
        try {
          await renameWithRetry(rollback, target)
        } catch (rollbackError) {
          // Preserve the full known-good directory for recovery.
          preserveRollback = true
          const saved = join(retiredPath(lease.journal), 'previous')
          const message = `无法恢复旧版，恢复目录为 ${saved}，归档前位于 ${rollback}`
          log(`install: ${message}: ${String(rollbackError)}`)
          throw new AggregateError([error, rollbackError], message)
        }
      }
      throw error
    }
    if (priorTree && !existing) {
      log(`install: recovered ${target} using the saved tree at ${priorTree}`)
    }
    await lifecycle?.afterCommit(freshInstall)
    return { files, bytes: total }
  } finally {
    await releaseInstall(lease, preserveRollback)
  }
}

/** Windows may still hold executable/DLL handles briefly after shutdown. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
}

/** Creates the Start Menu and desktop shortcuts (no prompt, as required). */
export function writeShortcuts(installDir: string): { startMenu: string; desktop: string } {
  const target = join(installDir, EXE)
  const paths = shortcuts()
  const options = {
    target,
    cwd: installDir,
    icon: target,
    iconIndex: 0,
    description: 'KevinLauncher'
  }
  shell.writeShortcutLink(paths.startMenu, 'create', options)
  shell.writeShortcutLink(paths.desktop, 'create', options)
  return paths
}

/**
 * Registers the uninstall entry so Windows Settings → Apps lists KevinLauncher
 * and can remove it (the UninstallString reopens this exe with `--uninstall`).
 */
export async function writeUninstallEntry(installDir: string, version: string): Promise<void> {
  const exe = join(installDir, EXE)
  const sizeKb = String(Math.max(1, Math.round((await directorySize(installDir)) / 1024)))
  await regAdd(UNINSTALL_KEY, [
    ['DisplayName', 'REG_SZ', 'KevinLauncher'],
    ['DisplayVersion', 'REG_SZ', version],
    ['Publisher', 'REG_SZ', 'Kevin'],
    ['DisplayIcon', 'REG_SZ', `${exe},0`],
    ['InstallLocation', 'REG_SZ', installDir],
    ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`],
    ['QuietUninstallString', 'REG_SZ', `"${exe}" --uninstall`],
    ['EstimatedSize', 'REG_DWORD', sizeKb],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['URLInfoAbout', 'REG_SZ', 'https://github.com/KevinYuHere/KevinLauncher']
  ])
  await regAdd(APP_KEY, [
    ['InstallLocation', 'REG_SZ', installDir],
    ['Version', 'REG_SZ', version]
  ])
  log(`install: uninstall entry written (${installDir})`)
}

// ----------------------------------------------------------------- uninstall

/**
 * Removes shortcuts, registry entries and the scheduled task, then deletes the
 * installation. Files of the running process cannot be deleted, so the caller
 * finishes with a small helper after exit (see `finishUninstall`).
 */
export async function removeInstallation(options: {
  installDir: string
  keepUserData: boolean
  onProgress?: (step: string) => void
}): Promise<void> {
  const { installDir, keepUserData, onProgress } = options
  const paths = shortcuts()

  onProgress?.('正在删除快捷方式…')
  await fs.rm(paths.startMenu, { force: true }).catch(() => {})
  await fs.rm(paths.desktop, { force: true }).catch(() => {})

  onProgress?.('正在移除注册表项…')
  await regDelete(UNINSTALL_KEY)
  await regDelete(UNINSTALL_KEY_MACHINE)
  await regDelete(APP_KEY)
  await removeAutoStartTask()

  if (!keepUserData) {
    onProgress?.('正在删除用户数据…')
    await fs.rm(app.getPath('userData'), { recursive: true, force: true }).catch(() => {})
  }

  onProgress?.('正在删除程序文件…')
  await fs.rm(installDir, { recursive: true, force: true }).catch(() => {})
}

/** Deletes whatever is left of the installation after this process exits. */
export function finishUninstall(installDir: string): void {
  const script = join(app.getPath('temp'), `kevin-uninstall-${Date.now()}.ps1`)
  const quoted = `'${installDir.replace(/'/g, "''")}'`
  const body = `
$ErrorActionPreference = 'SilentlyContinue'
$pid0 = ${process.pid}
while (Get-Process -Id $pid0 -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath ${quoted} -Recurse -Force
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force
`.trim()
  void fs.writeFile(script, body, 'utf-8').then(() => {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  })
}
