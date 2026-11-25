import { app, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { once } from 'events'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { directorySize } from './updateDownload'
import { AUTO_START_TASK } from './autostart'
import { currentAppVersion } from './appVersion'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { psDataLiteral } from './powershell'
import { log } from './logger'
import { directoriesOverlap } from '@shared/paths'
import { realDirectoryPath } from './dataDir'
import { createSiblingWorkspace, isFileSystemRoot } from './directoryPath'
import { availableSpace, requireDiskSpace, type SpaceNeed } from './diskSpace'
import { canonicalExecutable, hasProcessIdentity, ProcessTree, type ProcInfo } from './processTree'
import { requestLegacyLauncherClose } from './setupProcess'
import {
  assertTrialInstallDirectory, launcherDisplayName, launcherExecutableName as EXE,
  launcherEntryPath, launcherProcessNames, launcherProductName, launcherRuntimeExecutableName as RUNTIME,
  trialBuild, trialDirectory, trialShortcuts
} from './buildIdentity'

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
export const SETUP_EXIT_ARGUMENT = '--kevin-exit-for-setup'
/** Marker file inside the install directory (also used for stale-file cleanup). */
const INFO_FILE = 'install.json'

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
  beforeStage: (programSpace: readonly SpaceNeed[]) => Promise<void>
  afterCommit: (freshInstall: boolean) => Promise<void>
}

// ------------------------------------------------------------------- helpers

export function defaultInstallDir(): string {
  if (trialBuild) return join(trialDirectory('installed'), launcherProductName)
  const base = process.env.LOCALAPPDATA ?? app.getPath('home')
  return join(base, 'Programs', 'KevinLauncher')
}

const shortcuts = (): { startMenu: string; desktop: string } => trialBuild ? trialShortcuts() : ({
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
  if (trialBuild) return null
  try {
    const { stdout } = await exec('reg', ['query', key, '/v', value], { windowsHide: true })
    const match = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function regAdd(key: string, values: [string, string, string][]): Promise<void> {
  if (trialBuild) return
  for (const [name, type, data] of values) {
    await exec('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'], {
      windowsHide: true
    })
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

/** Public entry paths of the other launcher processes. */
export async function runningInstances(): Promise<string[]> {
  try {
    const names = new Set([...launcherProcessNames].map(name => name.toLowerCase()))
    const self = canonicalExecutable(launcherEntryPath())
    const instances = new Map<string, string>()
    for (const process of await ProcessTree.snapshot()) {
      if (!process.executable || !names.has(process.name.toLowerCase())) continue
      const entry = launcherEntryPath(process.executable)
      if (canonicalExecutable(entry) === self ||
          trialBuild && canonicalExecutable(dirname(entry)) !== canonicalExecutable(defaultInstallDir())) continue
      instances.set(canonicalExecutable(entry), entry)
    }
    return [...instances.values()]
  } catch {
    return []
  }
}

/** Identify both generations while keeping the current uninstaller's own process tree alive. */
export function processesUsingInstall(
  snapshot: ProcInfo[], targetDir: string,
  owner: { pid: number; ppid: number; execPath: string } = process
): number[] {
  const entry = canonicalExecutable(join(targetDir, EXE))
  const runtime = canonicalExecutable(join(targetDir, RUNTIME))
  const own = new Set(ProcessTree.descendants(snapshot, owner.pid))
  if (entry !== runtime && canonicalExecutable(owner.execPath) === runtime) {
    const parent = snapshot.find(item => item.pid === owner.ppid)
    if (parent?.executable && canonicalExecutable(parent.executable) === entry) own.add(parent.pid)
  }
  return snapshot.filter(item => {
    if (own.has(item.pid) || !item.executable) return false
    const path = canonicalExecutable(item.executable)
    return path === entry || path === runtime
  }).map(item => item.pid)
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
 * Match the public entry and the runtime by their exact installation paths.
 * Existing single-executable releases remain valid targets.
 *
 * Returns true when the executable is no longer in use.
 */
export async function closeRunningInstances(targetDir: string): Promise<boolean> {
  assertTrialInstallDirectory(targetDir)
  const exe = join(targetDir, EXE)
  const runtime = join(targetDir, RUNTIME)
  const initial = await ProcessTree.snapshot().catch(error => {
    log(`install: could not inspect running launcher processes (${String(error)})`)
    return null
  })
  if (!initial) return false
  const pids = processesUsingInstall(initial, targetDir)
  if (pids.length) {
    log(`install: requesting normal exit from ${pids.join(', ')} at ${targetDir}`)
    const hasCloseProtocol = await pathExists(join(targetDir, 'resources', 'release-compatibility.json'))
    try {
      if (hasCloseProtocol) {
        const env = { ...process.env }
        delete env.PORTABLE_EXECUTABLE_FILE
        delete env.PORTABLE_EXECUTABLE_DIR
        const messenger = spawn(exe, [SETUP_EXIT_ARGUMENT], {
          cwd: targetDir, env, windowsHide: true, stdio: 'ignore'
        })
        await once(messenger, 'spawn')
        messenger.unref()
      } else {
        const selected = new Set(pids)
        const sent = await requestLegacyLauncherClose(initial.filter(hasProcessIdentity)
          .filter(item => selected.has(item.pid) && !selected.has(item.ppid)))
        log(`install: legacy window close posted to ${sent} window(s)`)
      }
    } catch (error) {
      log(`install: launcher exit request failed (${String(error)})`)
    }
  }
  const ownsExecutable = canonicalExecutable(launcherEntryPath()) === canonicalExecutable(exe)
  const expires = Date.now() + 12_000
  let remaining: number[] | null = pids
  while (Date.now() < expires) {
    remaining = await ProcessTree.snapshot(AbortSignal.timeout(Math.max(1, expires - Date.now())))
      .then(snapshot => processesUsingInstall(snapshot, targetDir)).catch(() => null)
    if (remaining?.length === 0 && (ownsExecutable || await isUnlocked(exe) && await isUnlocked(runtime))) return true
    await new Promise((resolve) => setTimeout(resolve, 450))
  }
  log(`install: exit wait expired; remaining launcher PIDs: ${remaining?.join(', ') || 'none observed'}`)
  return false
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
  if (/^[a-zA-Z]:$/.test(trimmed)) return join(trimmed + '\\', launcherProductName)
  if (isFileSystemRoot(dir)) return join(dir, launcherProductName)
  if (trimmed.split(/[\\/]/).at(-1)?.toLowerCase() === launcherProductName.toLowerCase()) return trimmed
  return join(trimmed, launcherProductName)
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
    const location = await regQuery(UNINSTALL_KEY, 'InstallLocation')
    const registered = location && location.toLowerCase() === installDir.toLowerCase()
      ? await regQuery(UNINSTALL_KEY, 'DisplayVersion') : null
    if (registered && registered !== version) {
      await regAdd(UNINSTALL_KEY, [['DisplayVersion', 'REG_SZ', version]])
      const appLocation = await regQuery(APP_KEY, 'InstallLocation')
      if (appLocation?.toLowerCase() === installDir.toLowerCase()) {
        await regAdd(APP_KEY, [['Version', 'REG_SZ', version]])
      }
      log(`install: version entry updated to ${version}`)
    }
  } catch (error) {
    log(`install: could not sync the version entry (${(error as Error).message})`)
  }
}

/** Record the verified new version before it can become the running app. */
export async function recordVersionedInstallation(
  installDir: string, version: string, versionedDirectory: string
): Promise<void> {
  const info = await readInstallInfo(installDir)
  if (!info) return
  const paths = await listFiles(versionedDirectory)
  const files = new Set(info.files)
  for (const file of paths) files.add(`resources/app-${version}/${file}`)
  await writeFileAtomic(join(installDir, INFO_FILE), JSON.stringify({ ...info, files: [...files] }, null, 2))
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
  assertTrialInstallDirectory(dir)
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
export async function freeSpace(dir: string): Promise<number | null> {
  return availableSpace(dir)
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
const POST_COMMIT = 'post-commit.json'

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

async function findPostCommitRepair(
  target: string, version: string
): Promise<{ transaction: string; freshInstall: boolean } | undefined> {
  const parent = dirname(target)
  const entries = await fs.readdir(parent, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RETIRED_PREFIX)) continue
    const transaction = join(parent, entry.name)
    const journal = await readInstallJournal(transaction, target)
    if (!journal || retiredPath(journal) !== transaction) continue
    const result = await loadJsonSafe<{ version: string; freshInstall: boolean }>(
      join(transaction, POST_COMMIT), 1
    )
    if (result.status === 'ok' && result.value?.version === version &&
        typeof result.value.freshInstall === 'boolean') {
      return { transaction, freshInstall: result.value.freshInstall }
    }
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
  assertTrialInstallDirectory(requested)
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
    if (existing && lifecycle && await installedVersion(target) === version) {
      const repair = await findPostCommitRepair(target, version)
      if (repair) {
        await lifecycle.beforeStage([])
        await lifecycle.afterCommit(repair.freshInstall)
        await fs.rm(repair.transaction, { recursive: true, force: true })
        return { files, bytes: total }
      }
    }
    const priorTree = existing ? target : await findInterruptedInstall(target)
    const freshInstall = !priorTree || !(await installedVersion(priorTree))
    const previous = priorTree ? await readInstallInfo(priorTree) : null
    let unmanagedSize = 0
    if (priorTree) {
      const managed = new Set([...files, ...(previous?.files ?? []), INFO_FILE].map(file => file.toLowerCase()))
      for (const file of await listFiles(priorTree)) {
        if (!managed.has(file.toLowerCase())) unmanagedSize += (await fs.lstat(join(priorTree, file))).size
      }
    }
    const space = [{ path: target, bytes: total + unmanagedSize }]
    await requireDiskSpace(space)
    await lifecycle?.beforeStage(space)
    await requireDiskSpace(space)
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
    try {
      if (lifecycle) {
        await writeFileAtomic(join(lease.path, POST_COMMIT), JSON.stringify({ version, freshInstall }))
        await lifecycle.afterCommit(freshInstall)
      }
    } catch (error) {
      preserveRollback = true
      throw new Error('程序文件已安装，系统设置尚未完成。请重新运行同一安装器补完。旧版恢复目录：' +
        retiredPath(lease.journal), { cause: error })
    }
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
  assertTrialInstallDirectory(installDir)
  const target = join(installDir, EXE)
  const paths = shortcuts()
  const options = {
    target,
    cwd: installDir,
    icon: target,
    iconIndex: 0,
    description: launcherDisplayName
  }
  if (!shell.writeShortcutLink(paths.startMenu, 'create', options) ||
      !shell.writeShortcutLink(paths.desktop, 'create', options)) {
    throw new Error('Windows 快捷方式创建失败')
  }
  return paths
}

/**
 * Registers the uninstall entry so Windows Settings → Apps lists KevinLauncher
 * and can remove it (the UninstallString reopens this exe with `--uninstall`).
 */
export async function writeUninstallEntry(installDir: string, version: string): Promise<void> {
  if (trialBuild) return
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

/** Deferred cleanup inspects the current target of each system integration. */
export function uninstallIntegrationScript(installDir: string, removedDataDir?: string): string {
  assertTrialInstallDirectory(installDir)
  const registryPath = (key: string) => psDataLiteral(key.replace(/^(HKCU|HKLM)\\/, '$1:\\'))
  const shortcutsScript = `
$exe = ${psDataLiteral(join(installDir, EXE))}
if (!(Test-Path -LiteralPath $exe -ErrorAction Stop)) {
  $shortcutShell = New-Object -ComObject WScript.Shell
  foreach ($link in @(${Object.values(shortcuts()).map(psDataLiteral).join(',')})) {
    if (!(Test-Path -LiteralPath $link -PathType Leaf -ErrorAction Stop)) { continue }
    Assert-PlainPath $link
    if ($shortcutShell.CreateShortcut($link).TargetPath -ieq $exe) {
      Remove-Item -LiteralPath $link -ErrorAction Stop
    }
  }
`.trim()
  if (trialBuild) return shortcutsScript + '\n}'
  return shortcutsScript + `
  $tasks = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop
  foreach ($task in $tasks) {
    if ($task.TaskName -ieq ${psDataLiteral(AUTO_START_TASK)} -and
        @($task.Actions | Where-Object { $_.Execute -and $_.Execute.Trim('"') -ieq $exe }).Count -gt 0) {
      Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
    }
  }
  $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  if (Test-Path -LiteralPath $runKey -ErrorAction Stop) {
    $run = Get-Item -LiteralPath $runKey -ErrorAction Stop
    $quoted = '"' + $exe + '"'
    foreach ($name in $run.GetValueNames()) {
      $value = $run.GetValue($name)
      if ($value -is [string] -and ($value -ieq $exe -or $value -ieq $quoted -or
          $value.StartsWith($quoted + ' ', [StringComparison]::OrdinalIgnoreCase) -or
          $value.StartsWith($exe + ' ', [StringComparison]::OrdinalIgnoreCase))) {
        Remove-ItemProperty -LiteralPath $runKey -Name $name -ErrorAction Stop
      }
    }
  }
  foreach ($key in @(${[UNINSTALL_KEY, UNINSTALL_KEY_MACHINE].map(registryPath).join(',')})) {
    if (!(Test-Path -LiteralPath $key -ErrorAction Stop)) { continue }
    $location = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).InstallLocation
    if ($location -ieq $root) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop }
  }
  $appKey = ${registryPath(APP_KEY)}
  if (Test-Path -LiteralPath $appKey -ErrorAction Stop) {
    $properties = Get-ItemProperty -LiteralPath $appKey -ErrorAction Stop
    if ($properties.InstallLocation -ieq $root) {
      foreach ($name in @('Version', 'InstallLocation')) {
        if ($properties.PSObject.Properties[$name]) {
          Remove-ItemProperty -LiteralPath $appKey -Name $name -ErrorAction Stop
        }
      }
    }
    ${removedDataDir ? `if ($properties.DataDir -ieq ${psDataLiteral(removedDataDir)}) {
      Remove-ItemProperty -LiteralPath $appKey -Name 'DataDir' -ErrorAction Stop
    }` : ''}
  }
}
`
}
