import { parentPort } from 'node:worker_threads'
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { downloadFile } from '../services/downloader'
import { md5Bytes } from '../services/hash'
import { requireDiskSpace } from '../services/diskSpace'
import { closeDownloadWorkerRatePort } from '../services/rateLimit'
import { extractZip } from '../update/zipAes'
import { applyVfsManifest, readDeleteList, stageStaticFiles, validateArknightsManifest, type PatchManifest } from '../update/arknightsPatch'
import { akStageFiles, akStageRoot, arknightsRecoveryPending, createArknightsCommit, finishArknightsCommit } from '../update/arknightsCommit'
import { arknightsPath, missingPath } from '../update/arknightsPaths'
import { arknightsDeltaVolumes, arknightsPackageDirectory, cacheArknightsVolume, missingVolumeBytes } from '../update/arknightsPackages'
import { readLocalVersion, type AkPatch } from '../update/arknightsUpdate'

type Task = { type: 'cancel' } | { type: 'recover'; gameDir: string } | {
  type: 'start'
  gameDir: string
  targetVersion: string
  patch: AkPatch
  hpatchzPath: string
  preStagedDir?: string
}
type DeltaTask = Extract<Task, { type: 'start' }>
let controller: AbortController | null = null
const emit = (payload: Record<string, unknown>): void => parentPort?.postMessage(payload)

async function loadManifest(extractDir: string, patch: AkPatch, signal: AbortSignal): Promise<PatchManifest> {
  const file = await arknightsPath(extractDir, 'patch.json')
  let content = await fs.readFile(file).catch((error) => {
    if (missingPath(error)) return null
    throw error
  })
  const digest = patch.infoMd5?.toLowerCase()
  if ((!content || (digest && md5Bytes(content) !== digest)) && patch.infoUrl) {
    const response = await fetch(patch.infoUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
    if (!response.ok) throw new Error(`下载补丁清单失败：HTTP ${response.status}`)
    content = Buffer.from(await response.arrayBuffer())
  }
  if (!content || (digest && md5Bytes(content) !== digest)) throw new Error('补丁清单缺失或校验失败')
  const manifest = JSON.parse(content.toString('utf8')) as PatchManifest
  validateArknightsManifest(manifest)
  return manifest
}

async function mergeVolumes(paths: string[], directory: string, signal: AbortSignal): Promise<string> {
  if (paths.length === 1) return paths[0]
  const merged = join(directory, 'volumes.joined')
  for (const [index, path] of paths.entries()) {
    signal.throwIfAborted()
    await pipeline(createReadStream(path), createWriteStream(merged, { flags: index === 0 ? 'wx' : 'a' }), { signal })
  }
  return merged
}

async function runDelta(msg: DeltaTask, signal: AbortSignal): Promise<void> {
  const { gameDir, patch } = msg
  const directory = await arknightsPackageDirectory(gameDir, msg.targetVersion, 'delta', patch.parts)
  const deltaRoot = await arknightsPath(gameDir, '_kl_delta')
  const stageRoot = await akStageRoot(gameDir)
  const stageDir = await akStageFiles(gameDir)
  const extractDir = join(deltaRoot, 'files')
  try {
    for (const part of patch.parts) {
      signal.throwIfAborted()
      const destination = await arknightsPath(directory, part.name)
      if (msg.preStagedDir && await cacheArknightsVolume(
        await arknightsPath(msg.preStagedDir, part.name), destination, part)) continue
      await cacheArknightsVolume(await arknightsPath(gameDir, `Diffs/${part.name}`), destination, part)
    }
    await requireDiskSpace([{ path: directory, bytes: await missingVolumeBytes(directory, patch.parts) }])
    const paths: string[] = []
    let base = 0
    for (const part of patch.parts) {
      const destination = await arknightsPath(directory, part.name)
      paths.push(destination)
      await downloadFile({
        url: part.url, dest: destination, expectedSize: part.size, expectedMd5: part.md5, signal,
        onProgress: downloaded => emit({ type: 'progress', downloaded: base + downloaded, total: patch.size })
      })
      base += (await fs.stat(destination)).size
    }
    signal.throwIfAborted()
    await fs.rm(deltaRoot, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    const archiveBytes = (await Promise.all(paths.map(path => fs.stat(path)))).reduce((sum, part) => sum + part.size, 0)
    if (paths.length > 1) await requireDiskSpace([{ path: deltaRoot, bytes: archiveBytes }])
    const zipPath = await mergeVolumes(arknightsDeltaVolumes(paths, patch.parts.map(part => part.name)), deltaRoot, signal)
    emit({ type: 'extracting', message: '正在解压补丁…' })
    await extractZip({
      zipPath, destDir: extractDir, password: patch.cdKey, signal,
      beforeExtract: (size) => requireDiskSpace([{ path: extractDir, bytes: size }]),
      onProgress: (downloaded, total) => emit({ type: 'progress', downloaded, total })
    })
    const manifest = await loadManifest(extractDir, patch, signal)
    const deletes = await readDeleteList(extractDir)
    const extractedBytes = await directoryBytes(extractDir, signal)
    const vfsBytes = manifest.files.reduce((sum, node) => node.local_path || node.patch?.length ? sum + node.size : sum, 0)
    await requireDiskSpace([{ path: stageDir, bytes: extractedBytes + vfsBytes }])
    await fs.rm(stageRoot, { recursive: true, force: true })
    await fs.mkdir(stageDir, { recursive: true })
    emit({ type: 'extracting', message: '正在应用增量补丁…' })
    await stageStaticFiles(extractDir, stageDir, signal)
    await applyVfsManifest({
      extractDir, gameDir, stageDir, manifest, hpatchzPath: msg.hpatchzPath, signal,
      onProgress: (downloaded, total) => emit({ type: 'progress', downloaded, total })
    })
    if (await readLocalVersion(stageDir) !== msg.targetVersion) throw new Error('更新包中的游戏版本与目标版本不符')
    await createArknightsCommit(gameDir, msg.targetVersion, deletes, signal, {
      packageDir: directory, predownload: Boolean(msg.preStagedDir)
    })
    await commit(gameDir, signal)
  } finally {
    await fs.rm(deltaRoot, { recursive: true, force: true })
    if (!await arknightsRecoveryPending(gameDir)) await fs.rm(stageRoot, { recursive: true, force: true })
  }
}

async function directoryBytes(dir: string, signal: AbortSignal): Promise<number> {
  let size = 0
  for await (const entry of await fs.opendir(dir)) {
    signal.throwIfAborted()
    const path = join(dir, entry.name)
    if (entry.isDirectory()) size += await directoryBytes(path, signal)
    else if (entry.isFile()) size += (await fs.stat(path)).size
  }
  return size
}

async function commit(gameDir: string, signal: AbortSignal): Promise<void> {
  emit({ type: 'extracting', message: '正在提交已验证的游戏文件…' })
  const complete = await finishArknightsCommit(gameDir, signal,
    (downloaded, total) => emit({ type: 'progress', downloaded, total }))
  if (!complete) throw new Error('缺少明日方舟更新提交记录')
}

parentPort?.on('message', async (message: Task) => {
  if (message.type === 'cancel') {
    controller?.abort(new Error('已取消'))
    return
  }
  if (controller) return
  controller = new AbortController()
  const signal = controller.signal
  let terminal: Record<string, unknown>
  try {
    if (message.type === 'recover') await commit(message.gameDir, signal)
    else await runDelta(message, signal)
    terminal = { type: 'done' }
  } catch (error) {
    terminal = { type: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  // No filesystem work follows the terminal status.
  closeDownloadWorkerRatePort()
  emit(terminal)
  parentPort?.close()
})
