import { parentPort } from 'worker_threads'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { downloadFile } from '../services/downloader'
import { extractZip } from '../update/zipAes'
import {
  applyVfsManifest,
  commitStage,
  installConfig,
  processDeleteList,
  stageStaticFiles,
  type PatchManifest
} from '../update/arknightsPatch'
import type { AkPatch } from '../update/arknightsUpdate'

interface StartMessage {
  type: 'start'
  gameDir: string
  targetVersion: string
  patch: AkPatch
  hpatchzPath: string
}

let controller: AbortController | null = null

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Merge split zip volumes (`*.zip.001`, `.002`, …) into one file for reading. */
async function mergeVolumes(parts: string[], dest: string, signal: AbortSignal): Promise<string> {
  if (parts.length === 1) return parts[0]
  await fs.rm(dest, { force: true })
  for (const part of parts) {
    if (signal.aborted) throw new Error('已取消')
    await pipeline(createReadStream(part), createWriteStream(dest, { flags: 'a' }))
  }
  return dest
}

parentPort?.on('message', async (message: unknown) => {
  const msg = message as StartMessage | { type: 'cancel' }
  if (msg.type === 'cancel') {
    controller?.abort()
    return
  }
  if (msg.type !== 'start') return

  controller = new AbortController()
  const signal = controller.signal
  const emit = (payload: Record<string, unknown>): void => parentPort?.postMessage(payload)

  const diffsDir = join(msg.gameDir, 'Diffs')
  const extractDir = join(msg.gameDir, '_kl_delta')
  const stageDir = join(msg.gameDir, '_kl_stage')

  try {
    const { patch } = msg
    await fs.mkdir(diffsDir, { recursive: true })

    // 1) Download the (possibly split) encrypted patch archive with resume.
    const total = patch.parts.reduce((sum, part) => sum + part.size, 0)
    const partPaths: string[] = []
    let base = 0
    for (const part of patch.parts) {
      if (signal.aborted) throw new Error('已取消')
      const dest = join(diffsDir, part.name)
      partPaths.push(dest)
      const offset = base
      await downloadFile({
        url: part.url,
        dest,
        expectedSize: part.size,
        expectedMd5: part.md5,
        signal,
        onProgress: (downloaded) => emit({ type: 'progress', downloaded: offset + downloaded, total })
      })
      base += part.size
    }
    emit({ type: 'progress', downloaded: total, total })

    // 2) Extract, decrypting with the patch key.
    emit({ type: 'extracting', message: '正在解压补丁…' })
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    const zipPath = await mergeVolumes(partPaths, join(diffsDir, 'patch.zip'), signal)
    await extractZip({
      zipPath,
      destDir: extractDir,
      password: patch.cdKey,
      signal,
      onProgress: (extracted) => emit({ type: 'progress', downloaded: extracted, total })
    })
    await fs.rm(diffsDir, { recursive: true, force: true }).catch(() => undefined)

    // 3) Assemble the new files in a staging directory, then commit atomically.
    const manifest = await loadManifest(extractDir, patch)
    emit({ type: 'extracting', message: '正在应用增量补丁…' })
    await fs.rm(stageDir, { recursive: true, force: true })
    await fs.mkdir(stageDir, { recursive: true })
    await stageStaticFiles(extractDir, stageDir)
    await applyVfsManifest({
      extractDir,
      gameDir: msg.gameDir,
      stageDir,
      manifest,
      hpatchzPath: msg.hpatchzPath,
      signal,
      onProgress: (done, count) => emit({ type: 'progress', downloaded: done, total: count })
    })

    if (signal.aborted) throw new Error('已取消')
    emit({ type: 'extracting', message: '正在写入游戏目录…' })
    await commitStage(stageDir, msg.gameDir)
    await processDeleteList(extractDir, msg.gameDir, stageDir)
    await installConfig(extractDir, msg.gameDir)

    emit({ type: 'done' })
  } catch (error) {
    emit({
      type: 'error',
      message: (error as Error).message === '已取消' ? '已取消' : (error as Error).message
    })
  } finally {
    // Derived directories are always removed; `Diffs` is kept on failure so a
    // paused download can resume (it is deleted right after extraction above).
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    controller = null
  }
})

/** Read `patch.json` from the extracted archive (falling back to the API URL). */
async function loadManifest(extractDir: string, patch: AkPatch): Promise<PatchManifest> {
  const local = join(extractDir, 'patch.json')
  if (await exists(local)) {
    return JSON.parse(await fs.readFile(local, 'utf-8')) as PatchManifest
  }
  if (patch.infoUrl) {
    const res = await fetch(patch.infoUrl)
    if (!res.ok) throw new Error(`下载补丁清单失败：HTTP ${res.status}`)
    return (await res.json()) as PatchManifest
  }
  throw new Error('补丁清单缺失，无法应用更新')
}
