// Independently implemented FILE and component stages. Behavior reference: Starward 747ed10.
import { promises as fs } from 'fs'
import { extractHoYoArchive } from './hoyoArchive'
import { forEachResource, type HoYoStep } from './hoyoSchedule'
import type { HardLinkService } from '../services/hardLinkService'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { gamePath, retryHoYo, readGameRows, optionalText } from './hoyoFiles'
import { writeFileAtomic } from '../services/atomicFile'
import { downloadGameBytes, downloadGameFile } from './hoyoNetwork'
import { log } from '../services/logger'
import { psQuote, runPowerShell } from '../services/powershell'
import { md5File } from '../services/hash'
import { GAME_BIZ, getGamePlugins, type GamePlugin, getWPFPackage, getGameChannelSDK, getGameDeprecatedFiles, type ComponentPackage, type HoYoGameConfig, type HoYoGame, type PackageFile } from './hoyoplay'

const exec = promisify(execFile)

async function* gameFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of await fs.opendir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* gameFiles(path)
    else if (entry.isFile()) yield path
  }
}

export async function prepareGameDirectory(dir: string, config: HoYoGameConfig, audio: string[], scenario: string, signal: AbortSignal): Promise<void> {
  if (audio.length && config.audioScanDir) {
    const names: Record<string, string> = { 'zh-cn': 'Chinese', 'en-us': 'English(US)', 'ja-jp': 'Japanese', 'ko-kr': 'Korean' }
    await writeFileAtomic(gamePath(dir, config.audioScanDir), audio.map(lang => names[lang]).join('\r\n') + '\r\n')
  }
  if (config.enableScenario && config.scenarioFile) {
    await writeFileAtomic(gamePath(dir, config.scenarioFile), JSON.stringify({ packageType: scenario === 'CATEGORY_SCENARIO_BASE' ? 'BASE' : 'FULL' }))
  }
  signal.throwIfAborted()
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$directories = New-Object System.Collections.Stack',
      '$directories.Push((New-Object IO.DirectoryInfo(' + psQuote(dir) + ')))',
      'while ($directories.Count) {',
      '  foreach ($entry in $directories.Pop().EnumerateFileSystemInfos()) {',
      '    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }',
      '    if ($entry -is [IO.DirectoryInfo]) { $directories.Push($entry) }',
      '    elseif ($entry.Attributes -ne [IO.FileAttributes]::Normal) { $entry.Attributes = [IO.FileAttributes]::Normal }',
      '  }',
      '}'
    ].join('\n')
    await runPowerShell(script, { signal })
    return
  }
  for await (const file of gameFiles(dir)) {
    signal.throwIfAborted()
    await fs.chmod(file, 0o666)
  }
}

export async function cleanGameTemps(dir: string, signal: AbortSignal): Promise<void> {
  for await (const file of gameFiles(dir)) {
    signal.throwIfAborted()
    if (/\.tmp$|_tmp$/i.test(file)) await fs.unlink(file).catch(error => log('清理游戏临时文件失败：' + error.message))
  }
}

export async function moveCachedResources(dir: string, config: HoYoGameConfig, signal: AbortSignal): Promise<void> {
  async function moveTree(from: string, to: string): Promise<void> {
    let entries
    try { entries = await fs.readdir(from, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      signal.throwIfAborted()
      const source = join(from, entry.name), target = join(to, entry.name)
      if (entry.isDirectory()) await moveTree(source, target)
      if (entry.isFile()) {
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.rename(source, target)
      }
    }
  }
  if (config.audioCacheDir && config.audioResDir) {
    const from = gamePath(dir, config.audioCacheDir), to = gamePath(dir, config.audioResDir)
    if (from.toLowerCase() !== to.toLowerCase()) await moveTree(from, to)
  }
  if (config.localResDir && config.localResCacheDir && config.gameResCutDir) {
    for (const row of await readGameRows<{ fileName?: string }>(dir, config.gameResCutDir)) {
      if (!row.fileName?.trim()) continue
      const target = gamePath(dir, row.fileName)
      const source = gamePath(dir, row.fileName.replaceAll(config.localResDir, config.localResCacheDir))
      if (!await exists(target) && await exists(source)) {
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.rename(source, target)
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await fs.stat(path)).isFile() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function readIni(dir: string): Promise<Map<string, string>> {
  const text = await optionalText(join(dir, 'config.ini')) ?? ''
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    entries.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim())
  }
  return entries
}

export async function writeIni(dir: string, game: HoYoGame, ini: Map<string, string>): Promise<void> {
  ini.set('channel', '1')
  ini.set('sub_channel', '1')
  ini.set('game_biz', GAME_BIZ[game])
  const known = ['channel', 'sub_channel', 'cps', 'game_biz', 'game_version', 'sdk_version', 'wpf_version', 'uapc', 'downloading_mode']
  const lines = ['[General]']
  for (const [key, value] of ini) if (!known.includes(key)) lines.push(key + '=' + value)
  for (const key of known) if (ini.get(key)) lines.push(key + '=' + ini.get(key))
  await writeFileAtomic(join(dir, 'config.ini'), lines.join('\r\n') + '\r\n')
}

async function matches(file: string, size: number, md5: string): Promise<boolean> {
  try { return (await fs.stat(file)).size === size && (await md5File(file)) === md5.toLowerCase() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function verifiedDownload(file: PackageFile, path: string, signal: AbortSignal, progress: (n: number) => void): Promise<void> {
  if (!file.md5 || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('资源缺少大小或 MD5')
  const md5 = file.md5.toLowerCase()
  await retryHoYo(async () => {
    try {
      await downloadGameFile({ url: file.url, path, size: file.size, signal, onProgress: progress })
      if (!(await matches(path, file.size, md5))) throw new Error('资源校验失败')
      return
    } catch (error) {
      if (/校验失败/.test((error as Error).message)) await fs.rm(path, { force: true })
      throw error
    }
  }, signal)
}

async function transferFiles(files: PackageFile[], dir: string, signal: AbortSignal, update: (done: number, total: number) => void,
  replaceExisting: boolean): Promise<void> {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  const received = new Map<PackageFile, number>()
  let done = 0
  await forEachResource(files, signal, async (file, token) => {
    const destination = gamePath(dir, file.name)
    const report = (n: number) => {
      done += n - (received.get(file) ?? 0)
      received.set(file, n)
      update(done, total)
    }
    if (replaceExisting || !await exists(destination)) {
      const temporary = destination + '.tmp'
      await verifiedDownload(file, temporary, token, report)
      await fs.rename(temporary, destination)
    }
    report(file.size)
  }, false)
}

export function downloadPackages(dir: string, files: PackageFile[], signal: AbortSignal, update: (done: number, total: number) => void): Promise<void> {
  return transferFiles(files, dir, signal, update, false)
}



async function applyPackageDiffs(dir: string, hpatchz: string, signal: AbortSignal, links: HardLinkService): Promise<void> {
  async function patch(source: string, diff: string, target: string, token: AbortSignal): Promise<void> {
    const temp = target + '.tmp'
    try {
      if (await exists(source) && await exists(diff)) {
        await fs.rm(temp, { force: true })
        let applied = false
        try {
          await exec(hpatchz, ['-f', source, diff, temp], { windowsHide: true, signal: token })
          applied = true
        } catch (error) {
          token.throwIfAborted()
          log('游戏补丁处理失败：' + target + ' ' + (error as Error).message)
        }
        if (applied) {
          if (source.toLowerCase() !== target.toLowerCase()) {
            await fs.unlink(source)
            links.deleteFile(source)
          }
          await fs.rename(temp, target)
          void links.insert(target, (await fs.stat(target)).size, await md5File(target))
        }
      }
      await fs.rm(diff, { force: true })
    } catch (error) {
      token.throwIfAborted()
      log('游戏补丁文件处理失败：' + target + ' ' + (error as Error).message)
    } finally { await fs.rm(temp, { force: true }) }
  }
  const list = join(dir, 'hdifffiles.txt'), map = join(dir, 'hdiffmap.json'), deletes = join(dir, 'deletefiles.txt')
  const lines = await optionalText(list)
  if (lines !== null) {
    const rows = lines.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as { remoteName: string } | null)
    await forEachResource(rows, signal, async (row, token) => {
      if (row) {
        const target = gamePath(dir, row.remoteName)
        await patch(target, target + '.hdiff', target, token)
      }
    }, false)
    await fs.rm(list)
  }
  const mapping = await optionalText(map)
  if (mapping !== null) {
    const rows: { source_file_name: string; patch_file_name: string; target_file_name: string }[] = JSON.parse(mapping)?.diff_map ?? []
    await forEachResource(rows, signal, async (row, token) => {
      await patch(gamePath(dir, row.source_file_name), gamePath(dir, row.patch_file_name), gamePath(dir, row.target_file_name), token)
    }, false)
    await fs.rm(map)
  }
  const removed = await optionalText(deletes)
  if (removed !== null) {
    for (const line of removed.split(/\r?\n/).filter(s => s.trim())) {
      const path = gamePath(dir, line)
      await fs.rm(path, { force: true })
      links.deleteFile(path)
    }
    await fs.rm(deletes)
  }
}

export async function preparePackageVerification(dir: string, prefix: string, languages: string[], signal: AbortSignal): Promise<PackageFile[]> {
  if (!prefix.trim()) throw new Error('游戏资源缺少校验清单地址')
  const voices: Record<string, string> = {
    'zh-cn': 'Chinese', 'en-us': 'English(US)', 'ja-jp': 'Japanese', 'ko-kr': 'Korean'
  }
  const files = ['pkg_version', ...languages.map(lang => 'Audio_' + voices[lang] + '_pkg_version')]
  const rows: PackageFile[] = []
  await forEachResource(files, signal, async (file, token) => {
    const manifest = await retryHoYo(async () => {
      const contents = new TextDecoder().decode(await downloadGameBytes(prefix + '/' + file, token))
      const items = contents.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
      await writeFileAtomic(gamePath(dir, file), contents)
      return items
    }, token)
    for (const row of manifest) {
      if (row == null) continue
      gamePath(dir, row.remoteName)
      rows.push({ url: prefix + '/' + row.remoteName, name: row.remoteName, md5: row.md5, size: Number(row.fileSize) })
    }
  }, false)
  return rows
}

export async function verifyUpdatedPackages(dir: string, files: PackageFile[], signal: AbortSignal, progress: (done: number, total: number) => void): Promise<void> {
  const missing: PackageFile[] = []
  await forEachResource(files, signal, async file => {
    if (!await matches(gamePath(dir, file.name), file.size, file.md5!)) missing.push(file)
  })
  await transferFiles(missing, dir, signal, progress, true)
}

export async function applyPackages(dir: string, files: PackageFile[], hpatchz: string, signal: AbortSignal, links: HardLinkService): Promise<void> {
  const game = files.filter(file => !file.language)
  const groups = [game, ...files.filter(file => file.language).map(file => [file])]
  for (const group of groups.filter(group => group.length > 0)) {
    await extractHoYoArchive(group.map(file => gamePath(dir, file.name)), dir, signal, 'package')
    await applyPackageDiffs(dir, hpatchz, signal, links)
  }
  for (const file of files) await fs.rm(gamePath(dir, file.name))
}

export async function prepareComponents(game: HoYoGame, dir: string, ini: Map<string, string>, signal: AbortSignal) {
  const [wpf, sdk, plugins, deprecated] = await Promise.all([
    getWPFPackage(game, signal), getGameChannelSDK(game, signal), getGamePlugins(game, signal), getGameDeprecatedFiles(game, signal)
  ])
  let installSdk = !!sdk
  if (sdk && sdk.version === ini.get('sdk_version') && sdk.pkgVersionFile.trim()) {
    const manifest = await optionalText(gamePath(dir, sdk.pkgVersionFile))
    if (manifest !== null) {
      installSdk = false
      for (const line of manifest.split(/\r?\n/).filter(s => s.trim())) {
        const row = JSON.parse(line)
        if (row && !await matches(gamePath(dir, row.remoteName), Number(row.fileSize), row.md5)) {
          installSdk = true
          break
        }
      }
    }
  }
  return {
    wpf: wpf?.version === ini.get('wpf_version') ? null : wpf,
    sdk: installSdk ? sdk : null,
    plugins, deprecated
  }
}

async function pluginReady(dir: string, plugin: GamePlugin): Promise<boolean> {
  if (!plugin.validation.trim()) return false
  const list = JSON.parse(plugin.validation) as { path: string; size?: number | string; md5: string }[] | null
  if (!list) return false
  for (const item of list) {
    const path = gamePath(dir, item.path)
    if (item.size != null) {
      if (!await matches(path, Number(item.size), item.md5)) return false
    } else {
      try { if (!(await fs.stat(path)).isFile() || await md5File(path) !== item.md5?.toLowerCase()) return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }
  }
  return true
}

async function runPluginCommand(dir: string, command: string, signal: AbortSignal): Promise<void> {
  if (!command.trim()) return
  const space = command.indexOf(' ')
  const executable = gamePath(dir, space > 0 ? command.slice(0, space) : command)
  const args = space > 0 ? [command.slice(space + 1).trim()] : []
  try {
    await exec(executable, args, { cwd: dir, windowsHide: true, windowsVerbatimArguments: true, signal })
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code !== 'number') throw error
    log('游戏插件返回非零退出码：' + (error as Error).message)
  }
}

export function componentSteps(dir: string, ini: Map<string, string>, components: Awaited<ReturnType<typeof prepareComponents>>): HoYoStep[] {
  const steps: HoYoStep[] = []
  function install(pkg: ComponentPackage | null, key: string) {
    if (!pkg) return
    steps.push(async ({ signal, progress }) => {
      const archive = gamePath(dir, pkg.name)
      await verifiedDownload(pkg, archive, signal, n => progress(n, pkg.size))
      await extractHoYoArchive([archive], dir, signal, 'component')
      await fs.rm(archive)
      ini.set(key, pkg.version)
    })
  }
  install(components.wpf, 'wpf_version')
  install(components.sdk, 'sdk_version')
  if (components.plugins.length) steps.push(async ({ signal, progress }) => {
    for (const plugin of components.plugins) {
      const key = 'plugin_' + plugin.pluginId + '_version'
      try {
        if (!await pluginReady(dir, plugin)) {
          const archive = gamePath(dir, plugin.name)
          await verifiedDownload(plugin, archive, signal, n => progress(n, plugin.size))
          await extractHoYoArchive([archive], dir, signal, 'plugin')
          await runPluginCommand(dir, plugin.command, signal)
          await fs.rm(archive)
        }
        ini.set(key, plugin.version)
      } catch (error) { log('安装游戏插件失败：' + (error as Error).message) }
    }
  })
  if (components.deprecated.length) steps.push(async () => {
    for (const file of components.deprecated) await fs.unlink(gamePath(dir, file)).catch(() => undefined)
  })
  return steps
}
