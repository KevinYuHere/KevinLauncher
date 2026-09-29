import { app, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { promisify } from 'util'
import { directorySize } from './updateDownload'
import { removeAutoStartTask } from './autostart'
import { currentAppVersion } from './appVersion'
import { log } from './logger'

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
  await fs.writeFile(join(dir, INFO_FILE), JSON.stringify(info, null, 2), 'utf8')
}

/** Paths of every running KevinLauncher.exe that is not this process. */
export async function runningInstances(): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process KevinLauncher -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path'
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
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
  const target = `'${exe.replace(/'/g, "''")}'`
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process KevinLauncher -ErrorAction SilentlyContinue | ` +
          `Where-Object { $_.Path -ieq ${target} } | Select-Object -ExpandProperty Id`
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
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
      await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`
        ],
        { windowsHide: true }
      )
    } catch {
      /* reported through the return value */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  // Opening the exe for writing is the reliable "still running?" probe — it does
  // not depend on being able to read process paths.
  return isUnlocked(exe)
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
  if (/(^|[\\/])KevinLauncher$/i.test(trimmed)) return trimmed
  return join(trimmed, 'KevinLauncher')
}

/** Finds an existing installation (registry first, then the default path). */
export async function detectInstallation(): Promise<DetectedInstall | null> {
  for (const [key, source] of [
    [UNINSTALL_KEY, 'registry'],
    [UNINSTALL_KEY_MACHINE, 'registry']
  ] as const) {
    const dir = await regQuery(key, 'InstallLocation')
    if (dir && (await pathExists(join(dir, EXE)))) {
      return { dir, version: await regQuery(key, 'DisplayVersion'), source }
    }
  }
  const fallback = defaultInstallDir()
  if (await pathExists(join(fallback, EXE))) {
    return {
      dir: fallback,
      version: (await readInstallInfo(fallback))?.version ?? null,
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
      version: (await readInstallInfo(dir))?.version ?? null,
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
    version: info?.version ?? null,
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
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name ${letter}).Free`],
      { windowsHide: true }
    )
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

/**
 * Restarts the installer elevated (UAC). Returns false when the user declined
 * or elevation was impossible, so the caller can continue without it. The
 * portable executable is relaunched (not the extracted copy, which disappears
 * with this process).
 */
export async function relaunchInstallerElevated(): Promise<boolean> {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const args = process.argv.slice(1).filter((arg) => !arg.startsWith('--install-dir'))
  // `-ArgumentList @()` is rejected by Start-Process — omit it when empty.
  const script =
    `Start-Process -FilePath ${quote(exe)}` +
    (args.length ? ` -ArgumentList @(${args.map(quote).join(',')})` : '') +
    ' -Verb RunAs'
  try {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 180_000
    })
    return true
  } catch (error) {
    log(`install: elevation failed (${(error as Error).message})`)
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

/**
 * Copies every file of `sourceDir` into `targetDir`, removes files that only
 * existed in the previous installation and reports progress. Only the install
 * directory is touched — user data is never involved.
 */
export async function applyPayload(
  sourceDir: string,
  targetDir: string,
  onProgress?: (progress: ApplyProgress) => void
): Promise<{ files: string[]; bytes: number }> {
  const files = await listFiles(sourceDir)
  const previous = await readInstallInfo(targetDir)

  for (const stale of staleFiles(previous?.files ?? [], files)) {
    const full = join(targetDir, ...stale.split('/'))
    await fs.rm(full, { force: true }).catch(() => {})
  }

  const sizes = new Map<string, number>()
  let total = 0
  for (const file of files) {
    const size = (await fs.stat(join(sourceDir, ...file.split('/')))).size
    sizes.set(file, size)
    total += size
  }

  let done = 0
  let lastReport = 0
  for (const file of files) {
    const from = join(sourceDir, ...file.split('/'))
    const to = join(targetDir, ...file.split('/'))
    await fs.mkdir(dirname(to), { recursive: true })
    await copyWithRetry(from, to)
    done += sizes.get(file) ?? 0
    const now = Date.now()
    if (onProgress && (now - lastReport > 60 || done === total)) {
      lastReport = now
      onProgress({ done, total, current: file })
    }
  }

  await writeInstallInfo(targetDir, currentAppVersion(), files)
  return { files, bytes: total }
}

/**
 * Copies a file, retrying briefly: right after the running launcher is stopped
 * Windows may still hold the executable/DLL handles for a moment (EBUSY/EPERM).
 */
async function copyWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.copyFile(from, to)
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
