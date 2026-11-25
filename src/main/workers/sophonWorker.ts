import { parentPort } from 'worker_threads'
import { join } from 'path'
import { HardLinkService } from '../services/hardLinkService'
import { log } from '../services/logger'
import { withHoYoNetwork } from '../update/hoyoNetwork'
import { prepareChunkFiles, downloadSophonBuild, type PreparedChunkFiles } from '../update/sophon'
import { collectPatchFiles, runSophonPatch } from '../update/sophonPatch'
import { openSophonCacheOwnership } from '../update/sophonCacheOwnership'
import type { SophonCommand, SophonSetup } from '../update/hoyoWorker'

let task: SophonSetup | undefined
let links: HardLinkService | undefined
let prepared: PreparedChunkFiles | undefined, verification: PreparedChunkFiles | undefined
let patch: Awaited<ReturnType<typeof collectPatchFiles>> | undefined
const applied = new Set<string>(), verified = new Set<string>()
let controller: AbortController | undefined

async function execute(message: SophonCommand, signal: AbortSignal): Promise<void> {
  if (message.type === 'dispose' || message.type === 'park') {
    await links?.close()
    links = undefined
    prepared = undefined
    verification = undefined
    patch = undefined
    return
  }
  if (message.type === 'prepare') task = message.setup
  if (!task) throw new Error('游戏更新上下文缺失')
  links ??= new HardLinkService(task.userData, task.gameId)
  const { dir, plan, version, predownload, hpatchz, blacklist, work, cacheTarget } = task
  const opts = { links, categoriesSelected: true, blacklist, skipUnchanged: true, work }
  const target = plan.kind === 'chunk' ? plan.build : plan.mainBuild
  const report = (done: number, total: number) => parentPort?.postMessage({ type: 'progress', done, total })
  const notify = (p: { downloaded: number; total: number }) => report(p.downloaded, p.total)
  if (!prepared && !patch) {
    const preparations = [
      plan.kind === 'patch'
        ? collectPatchFiles(plan.patch, version, blacklist, signal).then(result => { patch = result })
        : prepareChunkFiles(target, { ...opts, localBuild: plan.localBuild }, signal).then(result => {
          prepared = result
          // Verification reads the same target manifest, including assets
          // unchanged from the local build. It needs no local-file shortcuts.
          if (!predownload) verification = { files: result.files, oldFiles: new Map(), oldChunks: new Map() }
        })
    ]
    if (!predownload && plan.kind === 'patch') {
      preparations.push(prepareChunkFiles(target, opts, signal).then(result => { verification = result }))
    }
    const results = await Promise.allSettled(preparations)
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  if (message.type === 'prepare') return
  if (message.type === 'verify') {
    await downloadSophonBuild(target, dir, notify, signal, { ...opts, prepared: verification, repair: true, finished: verified })
    return
  }
  const cache = predownload && cacheTarget ? await openSophonCacheOwnership(dir, cacheTarget) : undefined
  try {
    if (plan.kind === 'patch') {
      await runSophonPatch(plan.patch, version, dir, predownload, hpatchz, blacklist, report, signal, links, patch, applied, work, cache?.record)
    } else {
      await downloadSophonBuild(target, dir, notify, signal, { ...opts, prepared, originDir: dir, localBuild: plan.localBuild,
        cacheDir: join(dir, 'chunk'), cacheOnly: predownload, finished: applied, recordCache: cache?.record })
    }
  } finally {
    await cache?.save().catch(error => log('无法登记游戏预下载缓存文件', error))
  }
}

parentPort?.on('message', async (msg: SophonCommand | { type: 'cancel' }) => {
  if (msg.type === 'cancel') { controller?.abort(); return }
  controller = new AbortController()
  const signal = controller.signal
  try {
    const userData = msg.type === 'prepare' ? msg.setup.userData : task?.userData
    const version = msg.type === 'prepare' ? msg.setup.launcherVersion : task?.launcherVersion
    if (userData) await withHoYoNetwork(userData, 'runner', () => execute(msg, signal), version)
    else await execute(msg, signal)
    parentPort?.postMessage({ type: 'done' })
  } catch (error) {
    parentPort?.postMessage({ type: 'error', message: (error as Error).message })
  } finally { controller = undefined }
})
