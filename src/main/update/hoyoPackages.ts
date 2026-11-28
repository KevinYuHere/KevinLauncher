// Independently implemented FILE and component stages. Behavior reference: Starward 747ed10.
import { promises as fs } from 'fs'
import { extractHoYoArchive, gameArchiveBytes } from './hoyoArchive'
import { forEachResource, type HoYoStep } from './hoyoSchedule'
import type { HardLinkService } from '../services/hardLinkService'
import { dirname, join } from 'path'

import { gamePath, requirePlainGamePath, retryHoYo, readGameRows, optionalText } from './hoyoFiles'
import { writeFileAtomic } from '../services/atomicFile'
import { downloadGameBytes, downloadGameFile } from './hoyoNetwork'
import { log } from '../services/logger'
import { md5File, sha256Bytes } from '../services/hash'
import { allowGameFileWrite } from '../services/writableGameFile'
import { requireDiskSpace } from '../services/diskSpace'
import { runTaskProcess, TaskProcessExit } from '../services/taskProcess'
import { temporaryGameFile } from './hoyoTemp'
import { GAME_BIZ, getGamePlugins, type GamePlugin, getWPFPackage, getGameChannelSDK, getGameDeprecatedFiles, type ComponentPackage, type HoYoGameConfig, type HoYoGame, type PackageFile } from './hoyoplay'

async function writeMetadata(dir: string, path: string, value: string): Promise<void> {
  await requirePlainGamePath(dir, path)
  await requireDiskSpace([{ path, bytes: Buffer.byteLength(value) }])
  await allowGameFileWrite(path)
  await writeFileAtomic(path, value)
}

export async function prepareGameDirectory(dir: string, config: HoYoGameConfig, audio: string[], scenario: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (audio.length && config.audioScanDir) {
    const names: Record<string, string> = { 'zh-cn': 'Chinese', 'en-us': 'English(US)', 'ja-jp': 'Japanese', 'ko-kr': 'Korean' }
    await writeMetadata(dir, gamePath(dir, config.audioScanDir), audio.map(lang => names[lang]).join('\r\n') + '\r\n')
  }
  if (config.enableScenario && config.scenarioFile) {
    await writeMetadata(dir, gamePath(dir, config.scenarioFile), JSON.stringify({ packageType: scenario === 'CATEGORY_SCENARIO_BASE' ? 'BASE' : 'FULL' }))
  }
}

export async function moveCachedResources(dir: string, config: HoYoGameConfig, signal: AbortSignal): Promise<void> {
  async function moveTree(from: string, to: string): Promise<void> {
    await requirePlainGamePath(dir, from)
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
        await requirePlainGamePath(dir, target)
        await fs.mkdir(dirname(target), { recursive: true })
        await allowGameFileWrite(target)
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
        await requirePlainGamePath(dir, source)
        await requirePlainGamePath(dir, target)
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

export async function writeIni(dir: string, game: HoYoGame, ini: Map<string, string>): Promise<void> {
  ini.set('channel', '1')
  ini.set('sub_channel', '1')
  ini.set('game_biz', GAME_BIZ[game])
  const known = ['channel', 'sub_channel', 'cps', 'game_biz', 'game_version', 'sdk_version', 'wpf_version', 'uapc', 'downloading_mode']
  const lines = ['[General]']
  for (const [key, value] of ini) if (!known.includes(key)) lines.push(key + '=' + value)
  for (const key of known) if (ini.get(key)) lines.push(key + '=' + ini.get(key))
  await writeMetadata(dir, join(dir, 'config.ini'), lines.join('\r\n') + '\r\n')
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
  work: string): Promise<void> {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  const needed = new Set<PackageFile>()
  let bytesToWrite = 0
  for (const file of files) {
    signal.throwIfAborted()
    const destination = gamePath(dir, file.name)
    if (!file.md5 || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('资源缺少大小或 MD5')
    if (await matches(destination, file.size, file.md5)) continue
    needed.add(file)
    const temporary = temporaryGameFile(dir, work, 'downloads', destination)
    const partial = (await fs.stat(temporary).catch(() => undefined))?.size ?? 0
    bytesToWrite += partial < file.size ? file.size - partial : (await matches(temporary, file.size, file.md5) ? 0 : file.size)
  }
  await requireDiskSpace([{ path: dir, bytes: bytesToWrite }])
  const received = new Map<PackageFile, number>()
  let done = 0
  await forEachResource(files, signal, async (file, token) => {
    const destination = gamePath(dir, file.name)
    const report = (n: number) => {
      done += n - (received.get(file) ?? 0)
      received.set(file, n)
      update(done, total)
    }
    if (needed.has(file)) {
      const temporary = temporaryGameFile(dir, work, 'downloads', destination)
      await requirePlainGamePath(dir, temporary)
      await requirePlainGamePath(dir, destination)
      await verifiedDownload(file, temporary, token, report)
      await fs.mkdir(dirname(destination), { recursive: true })
      await allowGameFileWrite(destination)
      await fs.rename(temporary, destination)
    }
    report(file.size)
  }, false)
}

export function downloadPackages(dir: string, files: PackageFile[], signal: AbortSignal, update: (done: number, total: number) => void,
  work: string): Promise<void> {
  return transferFiles(files, dir, signal, update, work)
}



async function applyPackageDiffs(dir: string, hpatchz: string, signal: AbortSignal, links: HardLinkService, work: string,
  expected: Map<string, PackageFile>
): Promise<void> {
  async function patch(source: string, diff: string, target: string, token: AbortSignal): Promise<void> {
    const temp = temporaryGameFile(dir, work, 'patches', target)
    for (const path of new Set([source, diff, target, temp])) await requirePlainGamePath(dir, path)
    try {
      if (await exists(source) && await exists(diff)) {
        await fs.rm(temp, { force: true })
        let applied = false
        try {
          const targetInfo = expected.get(target.toLowerCase())
          if (!targetInfo?.md5) throw new Error('未找到差量目标的校验清单')
          await requireDiskSpace([{ path: temp, bytes: targetInfo.size }])
          await fs.mkdir(dirname(temp), { recursive: true })
          await runTaskProcess(hpatchz, ['-f', source, diff, temp], { signal: token })
          applied = await matches(temp, targetInfo.size, targetInfo.md5)
        } catch (error) {
          token.throwIfAborted()
          log('游戏补丁处理失败：' + target + ' ' + (error as Error).message)
        }
        if (applied) {
          await fs.mkdir(dirname(target), { recursive: true })
          await allowGameFileWrite(target)
          await fs.rename(temp, target)
          if (source.toLowerCase() !== target.toLowerCase()) {
            await allowGameFileWrite(source)
            await fs.unlink(source)
            links.deleteFile(source)
          }
          void links.insert(target, (await fs.stat(target)).size, await md5File(target))
        }
      }
      await allowGameFileWrite(diff)
      await fs.rm(diff, { force: true })
    } catch (error) {
      token.throwIfAborted()
      log('游戏补丁文件处理失败：' + target + ' ' + (error as Error).message)
    } finally { await fs.rm(temp, { force: true }) }
  }
  const list = join(dir, 'hdifffiles.txt'), map = join(dir, 'hdiffmap.json'), deletes = join(dir, 'deletefiles.txt')
  for (const file of [list, map, deletes]) await requirePlainGamePath(dir, file)
  const lines = await optionalText(list)
  if (lines !== null) {
    const rows = lines.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as { remoteName: string } | null)
    await forEachResource(rows, signal, async (row, token) => {
      if (row) {
        const target = gamePath(dir, row.remoteName)
        await patch(target, target + '.hdiff', target, token)
      }
    }, false)
    await allowGameFileWrite(list)
    await fs.rm(list)
  }
  const mapping = await optionalText(map)
  if (mapping !== null) {
    const rows: { source_file_name: string; patch_file_name: string; target_file_name: string }[] = JSON.parse(mapping)?.diff_map ?? []
    await forEachResource(rows, signal, async (row, token) => {
      await patch(gamePath(dir, row.source_file_name), gamePath(dir, row.patch_file_name), gamePath(dir, row.target_file_name), token)
    }, false)
    await allowGameFileWrite(map)
    await fs.rm(map)
  }
  const removed = await optionalText(deletes)
  if (removed !== null) {
    for (const line of removed.split(/\r?\n/).filter(s => s.trim())) {
      const path = gamePath(dir, line)
      await requirePlainGamePath(dir, path)
      await allowGameFileWrite(path)
      await fs.rm(path, { force: true })
      links.deleteFile(path)
    }
    await allowGameFileWrite(deletes)
    await fs.rm(deletes)
  }
}

export async function preparePackageVerification(dir: string, prefix: string, languages: string[], signal: AbortSignal, work: string) {
  if (!prefix.trim()) throw new Error('游戏资源缺少校验清单地址')
  const voices: Record<string, string> = {
    'zh-cn': 'Chinese', 'en-us': 'English(US)', 'ja-jp': 'Japanese', 'ko-kr': 'Korean'
  }
  const files = ['pkg_version', ...languages.map(lang => 'Audio_' + voices[lang] + '_pkg_version')]
  const digests = new Map<string, string>()
  async function read(download: boolean, signal: AbortSignal): Promise<PackageFile[]> {
    const rows: PackageFile[] = []
    await forEachResource(files, signal, async (file, token) => {
      const path = gamePath(dir, file)
      const snapshot = temporaryGameFile(dir, work, 'manifests', path)
      await requirePlainGamePath(dir, snapshot)
      const load = async () => {
        const contents = download
          ? new TextDecoder().decode(await downloadGameBytes(prefix + '/' + file, token))
          : await fs.readFile(snapshot, 'utf8')
        const digest = sha256Bytes(Buffer.from(contents))
        if (!download && digests.get(file) !== digest) throw new Error('等待期间游戏校验清单已改变，请重新检查更新')
        const manifest: PackageFile[] = []
        for (const line of contents.split(/\r?\n/).filter(line => line.trim())) {
          const row = JSON.parse(line)
          if (row == null) continue
          gamePath(dir, row.remoteName)
          manifest.push({ url: prefix + '/' + row.remoteName, name: row.remoteName, md5: row.md5, size: Number(row.fileSize) })
        }
        token.throwIfAborted()
        if (download) {
          await writeMetadata(dir, snapshot, contents)
          await writeMetadata(dir, path, contents)
          digests.set(file, digest)
        }
        for (const row of manifest) rows.push(row)
      }
      if (download) await retryHoYo(load, token)
      else await load()
    }, false)
    return rows
  }
  let prepared: PackageFile[] | undefined = await read(true, signal)
  return {
    async load(signal: AbortSignal): Promise<PackageFile[]> { return prepared ??= await read(false, signal) },
    park(): void { prepared = undefined }
  }
}

export async function verifyUpdatedPackages(dir: string, files: PackageFile[], signal: AbortSignal, progress: (done: number, total: number) => void,
  work: string
): Promise<void> {
  const missing: PackageFile[] = []
  await forEachResource(files, signal, async file => {
    if (!await matches(gamePath(dir, file.name), file.size, file.md5!)) missing.push(file)
  })
  await transferFiles(missing, dir, signal, progress, work)
}

export async function applyPackages(dir: string, files: PackageFile[], hpatchz: string, signal: AbortSignal, links: HardLinkService,
  work: string, verification: PackageFile[]
): Promise<void> {
  const game = files.filter(file => !file.language)
  const groups = [game, ...files.filter(file => file.language).map(file => [file])]
  const expected = new Map(verification.map(file => [gamePath(dir, file.name).toLowerCase(), file]))
  for (const group of groups.filter(group => group.length > 0)) {
    const archive = group.map(file => gamePath(dir, file.name))
    await requireDiskSpace([{ path: dir, bytes: await gameArchiveBytes(archive, dir, signal) }])
    await extractHoYoArchive(archive, dir, signal, 'package')
    await applyPackageDiffs(dir, hpatchz, signal, links, work, expected)
  }
  for (const file of files) {
    const path = gamePath(dir, file.name)
    await requirePlainGamePath(dir, path)
    await allowGameFileWrite(path)
    await fs.rm(path)
  }
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
  await requirePlainGamePath(dir, executable)
  const args = space > 0 ? [command.slice(space + 1).trim()] : []
  try {
    await runTaskProcess(executable, args, { cwd: dir, windowsVerbatimArguments: true, signal })
  } catch (error) {
    if (!(error instanceof TaskProcessExit) || error.code === null) throw error
    log('游戏插件返回非零退出码：' + (error as Error).message)
  }
}

export function componentSteps(dir: string, ini: Map<string, string>, components: Awaited<ReturnType<typeof prepareComponents>>,
  work: string
): HoYoStep[] {
  const steps: HoYoStep[] = []
  function install(pkg: ComponentPackage | null, key: string) {
    if (!pkg) return
    steps.push(async ({ signal, progress }) => {
      const archive = gamePath(dir, pkg.name)
      await transferFiles([pkg], dir, signal, progress, work)
      await requireDiskSpace([{ path: dir, bytes: await gameArchiveBytes([archive], dir, signal) }])
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
          await transferFiles([plugin], dir, signal, progress, work)
          await requireDiskSpace([{ path: dir, bytes: await gameArchiveBytes([archive], dir, signal) }])
          await extractHoYoArchive([archive], dir, signal, 'plugin')
          await runPluginCommand(dir, plugin.command, signal)
          await fs.rm(archive)
        }
        ini.set(key, plugin.version)
      } catch (error) { log('安装游戏插件失败：' + (error as Error).message) }
    }
  })
  if (components.deprecated.length) steps.push(async () => {
    for (const file of components.deprecated) {
      const path = gamePath(dir, file)
      await requirePlainGamePath(dir, path).then(() => allowGameFileWrite(path)).then(() => fs.unlink(path)).catch(() => undefined)
    }
  })
  return steps
}
