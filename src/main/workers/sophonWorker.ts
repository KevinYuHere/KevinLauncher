import { parentPort } from 'worker_threads'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { getSophonBuild, downloadSophonBuild } from '../update/sophon'
import { getPatchBuild, applySophonPatch } from '../update/sophonPatch'

interface StartMessage {
  type: 'start'
  branch: { branch: string; packageId: string; password: string }
  destDir: string
  mode: 'update' | 'preDownload'
  skipUnchanged: boolean
  localVersion?: string
  hpatchzPath?: string
  promoteFrom?: string
}

let controller: AbortController | null = null

async function copyDir(from: string, to: string, signal?: AbortSignal): Promise<void> {
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (signal?.aborted) throw new Error('cancelled')
    if (entry.name === 'state.json') continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      await fs.mkdir(dst, { recursive: true })
      await copyDir(src, dst, signal)
    } else {
      await fs.mkdir(dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
    }
  }
}

parentPort?.on('message', async (message: unknown) => {
  const msg = message as StartMessage | { type: 'cancel' }
  if (msg.type === 'cancel') {
    controller?.abort()
    return
  }
  if (msg.type !== 'start') return

  controller = new AbortController()
  const emitProgress = (downloaded: number, total: number): void => {
    parentPort?.postMessage({ type: 'progress', downloaded, total })
  }

  try {
    const build = await getSophonBuild(msg.branch)
    parentPort?.postMessage({ type: 'meta', tag: build.tag })

    // Promote a completed (or partial) pre-download into the target directory
    // first; the following download then only fills in what is missing.
    if (msg.promoteFrom) {
      try {
        await fs.access(msg.promoteFrom)
        parentPort?.postMessage({ type: 'phase', message: '正在应用已预下载的文件…' })
        await copyDir(msg.promoteFrom, msg.destDir, controller.signal)
      } catch {
        /* no usable pre-download */
      }
    }

    let patched = false
    if (msg.mode === 'update' && msg.localVersion && msg.hpatchzPath) {
      try {
        const patchBuild = await getPatchBuild(msg.branch)
        if (patchBuild.categories.some((c) => c.versions[msg.localVersion as string])) {
          parentPort?.postMessage({ type: 'phase', message: '正在应用增量补丁…' })
          await applySophonPatch(
            patchBuild,
            build,
            msg.localVersion,
            msg.destDir,
            msg.hpatchzPath,
            emitProgress,
            controller.signal
          )
          patched = true
        }
      } catch {
        // Patch failed — fall back to full/incremental download.
        parentPort?.postMessage({ type: 'phase', message: '补丁不可用，改为文件级增量下载…' })
      }
    }

    if (!patched) {
      await downloadSophonBuild(
        build,
        msg.destDir,
        (progress) => emitProgress(progress.downloaded, progress.total),
        controller.signal,
        msg.skipUnchanged
      )
    }
    parentPort?.postMessage({ type: 'done' })
  } catch (error) {
    const message = (error as Error).message
    parentPort?.postMessage({ type: 'error', message: message === 'cancelled' ? '已取消' : message })
  } finally {
    controller = null
  }
})
