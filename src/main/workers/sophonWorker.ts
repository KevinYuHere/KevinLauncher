import { parentPort } from 'worker_threads'
import { join } from 'path'
import { getSophonBuild, downloadSophonBuild, BuildNotFound } from '../update/sophon'
import { getPatchBuild, applySophonPatch, preparePatchCache, PatchBuildNotFound } from '../update/sophonPatch'

interface StartMessage {
  type: 'start'
  branch: { branch: string; packageId: string; password: string }
  destDir: string
  /** Installed game dir: patch/chunk originals + delta comparison. */
  originDir?: string
  mode: 'update' | 'preDownload'
  localVersion?: string
  hpatchzPath?: string
  audioLanguages?: string[]
  ignoreFields?: string[]
  /** Install versions a patch build can update from (`branch.diff_tags`). */
  diffTags?: string[]
  /** Files listed in the game's resource blacklist. */
  blacklist?: string[]
}

let controller: AbortController | null = null

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
  const post = (payload: Record<string, unknown>): void => {
    parentPort?.postMessage(payload)
  }

  try {
    const build = await getSophonBuild(msg.branch)
    post({ type: 'meta', tag: build.tag })

    // Pre-download only fills the caches (`chunk/`, `ldiff/`); the formal update
    // assembles/applies them. `destDir` is always the install dir.
    const installDir = msg.destDir
    const cacheOnly = msg.mode === 'preDownload'
    let patched = false

    // Patch mode (diff from the installed version) is used for pre-download too.
    // Like Starward: only when `diff_tags` lists the installed version, and a
    // patch that then fails aborts the task (no full-download fallback).
    const canPatch = msg.diffTags ? msg.diffTags.includes(msg.localVersion ?? '') : true
    let patchBuild: Awaited<ReturnType<typeof getPatchBuild>> | null = null
    if (msg.localVersion && msg.hpatchzPath && canPatch) {
      try {
        patchBuild = await getPatchBuild(msg.branch)
      } catch (error) {
        // Only a missing patch build falls back to chunk mode.
        if (error instanceof PatchBuildNotFound) patchBuild = null
        else throw error
      }
      if (patchBuild && !patchBuild.categories.some((c) => c.versions[msg.localVersion as string])) {
        patchBuild = null
      }
    }
    if (patchBuild && msg.localVersion && msg.hpatchzPath) {
      // Starward downloads and verifies every unique patch file first, then
      // applies them (a pre-download runs only the download step).
      post({
        type: 'phase',
        message: cacheOnly ? '正在下载预下载补丁…' : '正在下载更新补丁…'
      })
      await preparePatchCache(
        patchBuild,
        msg.localVersion,
        installDir,
        msg.audioLanguages ?? [],
        msg.ignoreFields ?? [],
        emitProgress,
        controller.signal
      )
      if (!cacheOnly) {
        post({ type: 'phase', message: '正在应用增量补丁…' })
        await applySophonPatch(
          patchBuild,
          build,
          msg.localVersion,
          installDir,
          installDir,
          msg.hpatchzPath,
          emitProgress,
          controller.signal,
          msg.audioLanguages ?? [],
          msg.ignoreFields ?? [],
          join(installDir, 'ldiff'),
          false,
          msg.blacklist ?? [],
          true
        )
      }
      patched = true
    }
    if (!patched) {
      // The installed version's manifests let unchanged chunks be copied from
      // the local game files instead of being downloaded again.
      post({
        type: 'phase',
        message: cacheOnly ? '正在获取预下载文件清单…' : '正在获取更新文件清单…'
      })
      let localBuild: Awaited<ReturnType<typeof getSophonBuild>> | undefined
      if (msg.localVersion) {
        try {
          localBuild = await getSophonBuild(msg.branch, msg.localVersion)
        } catch (error) {
          // Only a missing local build means no reuse; network errors abort.
          if (error instanceof BuildNotFound) localBuild = undefined
          else throw error
        }
      }
      await downloadSophonBuild(
        build,
        installDir,
        (progress) => emitProgress(progress.downloaded, progress.total),
        controller.signal,
        {
          skipUnchanged: true,
          originDir: installDir,
          audioLanguages: msg.audioLanguages,
          ignoreFields: msg.ignoreFields,
          localBuild,
          cacheDir: join(installDir, 'chunk'),
          cacheOnly,
          blacklist: msg.blacklist ?? []
        }
      )
    }

    post({ type: 'done' })
  } catch (error) {
    const message = (error as Error).message
    post({ type: 'error', message: message === 'cancelled' ? '已取消' : message })
  } finally {
    controller = null
  }
})
