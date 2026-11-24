import { parentPort } from 'worker_threads'
import { join } from 'path'
import { promises as fs } from 'fs'
import { HardLinkService } from '../services/hardLinkService'
import { withHoYoNetwork } from '../update/hoyoNetwork'
import { prepareChunkFiles, downloadSophonBuild, type PreparedChunkFiles } from '../update/sophon'
import { collectPatchFiles, runSophonPatch } from '../update/sophonPatch'
import type { SophonCommand, SophonSetup } from '../update/hoyoWorker'

let task: SophonSetup | undefined
let links: HardLinkService | undefined
let prepared: PreparedChunkFiles | undefined, verification: PreparedChunkFiles | undefined
let patch: Awaited<ReturnType<typeof collectPatchFiles>> | undefined
const applied = new Set<string>(), verified = new Set<string>()
let controller: AbortController | undefined

async function execute(message: SophonCommand, signal: AbortSignal): Promise<void> {
  if (message.type === 'dispose') { await links?.close(); return }
  if (message.type === 'prepare') {
    task = message.setup
    links = new HardLinkService(task.userData, task.gameId)
  }
  if (!task || !links) throw new Error('游戏更新上下文缺失')
  const { dir, plan, version, predownload, hpatchz, blacklist } = task
  const opts = { links, categoriesSelected: true, blacklist, skipUnchanged: true }
  const target = plan.kind === 'chunk' ? plan.build : plan.mainBuild
  const report = (done: number, total: number) => parentPort?.postMessage({ type: 'progress', done, total })
  const notify = (p: { downloaded: number; total: number }) => report(p.downloaded, p.total)
  if (message.type === 'prepare') {
    const preparations = [
      plan.kind === 'patch'
        ? collectPatchFiles(plan.patch, version, blacklist, signal).then(result => { patch = result })
        : prepareChunkFiles(target, { ...opts, localBuild: plan.localBuild }, signal).then(result => { prepared = result })
    ]
    if (!predownload) preparations.push(prepareChunkFiles(target, opts, signal).then(result => { verification = result }))
    const results = await Promise.allSettled(preparations)
    for (const result of results) if (result.status === 'rejected') throw result.reason
    return
  }
  if (message.type === 'verify') {
    await downloadSophonBuild(target, dir, notify, signal, { ...opts, prepared: verification, repair: true, finished: verified })
    return
  }
  if (plan.kind === 'patch') {
    await runSophonPatch(plan.patch, version, dir, predownload, hpatchz, blacklist, report, signal, links, patch, applied)
  } else {
    await downloadSophonBuild(target, dir, notify, signal, { ...opts, prepared, originDir: dir, localBuild: plan.localBuild,
      cacheDir: join(dir, 'chunk'), cacheOnly: predownload, finished: applied })
  }
  if (!predownload) for (const name of ['chunk', 'ldiff']) {
    const folder = join(dir, name)
    try {
      if ((await fs.stat(folder)).isDirectory()) {
        await fs.rm(folder, { recursive: true })
        links.deleteFolder(folder)
      }
    } catch { /* best-effort post-update cleanup */ }
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
