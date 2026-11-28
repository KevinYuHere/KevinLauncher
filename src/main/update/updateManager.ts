import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'path'
import { promises as fs } from 'fs'
import type { GachaGame, UpdateMode, UpdateStatus } from '@shared/types'
import { compareVersions } from '@shared/version'
import { directoriesOverlap } from '@shared/paths'
import { downloadFile } from '../services/downloader'
import { isFileSystemRoot, realDirectoryPath } from '../services/directoryPath'
import { requireDiskSpace } from '../services/diskSpace'
import type { HoYoGame } from './hoyoplay'
import { prepareHoYoJob } from './hoyoJob'
import { HoYoWorkerStopped } from './hoyoWorker'
import type { HoYoSteps } from './hoyoSchedule'
import { withHoYoNetwork } from './hoyoNetwork'
import { currentAppVersion } from '../services/appVersion'
import { trialBuild } from '@shared/buildIdentity'
import {
  getArknightsLatest,
  readAkPredownloadState,
  readLocalVersion,
  writeAkPredownloadState,
  type AkPack
} from './arknightsUpdate'
import sophonWorkerPath from '../workers/sophonWorker?modulePath'
import arknightsWorkerPath from '../workers/arknightsWorker?modulePath'
import { createDownloadWorker } from '../services/rateLimit'
import { log } from '../services/logger'
import { akStageFiles, akStageRoot, arknightsRecoveryPending, createArknightsCommit, finishArknightsCommit } from './arknightsCommit'
import { arknightsFileName, arknightsPath } from './arknightsPaths'
import { arknightsFullVolumes, arknightsPackageDirectory, cacheArknightsVolume, missingVolumeBytes, validateArknightsPackages } from './arknightsPackages'
import { extractHoYoArchive, gameArchiveBytes } from './hoyoArchive'

interface Job {
  controller: AbortController
  status: UpdateStatus
  installation?: { game: GachaGame; directory: string }
  simulated?: boolean
  simulatedStopAt?: number
  /** Timestamp of the last progress broadcast (download throttling). */
  lastProgressEmit: number
  /** Pending trailing broadcast that guarantees the newest value is shown. */
  progressTimer?: ReturnType<typeof setTimeout>
}

/** Progress broadcasts are throttled to this interval so the UI can be read. */
const PROGRESS_INTERVAL_MS = 1000
const PARK_DELAY_MS = 5 * 60_000

interface HoYoContext {
  directory: string
  mode: UpdateMode
  steps: HoYoSteps
  parkTimer?: ReturnType<typeof setTimeout>
  parked?: Promise<void>
}

const IDLE = (appId: string): UpdateStatus => ({
  appId,
  phase: 'idle',
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0
})

/** Orchestrates game update / pre-download (miHoYo + Arknights). */
export class UpdateManager {
  private readonly jobs = new Map<string, Job>()
  private readonly activeInstalls = new Map<string, { job: Job; game: GachaGame; directory: string; finished: Promise<void> }>()
  private readonly stopSimulation = new Map<string, () => void>()
  private stopping = false
  private readonly listeners = new Set<(status: UpdateStatus) => void>()

  onProgress(callback: (status: UpdateStatus) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emit(status: UpdateStatus): void {
    // Multiple launcher entries can refer to the same game installation.
    for (const [appId, job] of this.jobs) {
      if (job.status !== status) continue
      for (const listener of this.listeners) listener({ ...status, appId })
    }
  }

  /**
   * Broadcast a download-progress update at most once per second. Downloads
   * report progress far more often than a human can read; without this the
   * percentage / ring jumps around. A trailing timer makes sure the final value
   * still lands (and phase changes keep using `emit` directly).
   */
  private emitProgress(status: UpdateStatus): void {
    const job = this.jobs.get(status.appId)
    if (!job) return
    const elapsed = Date.now() - job.lastProgressEmit
    if (elapsed >= PROGRESS_INTERVAL_MS) {
      job.lastProgressEmit = Date.now()
      this.emit(status)
      return
    }
    if (job.progressTimer) return
    job.progressTimer = setTimeout(() => {
      job.progressTimer = undefined
      job.lastProgressEmit = Date.now()
      this.emit(job.status)
    }, PROGRESS_INTERVAL_MS - elapsed)
  }

  private clearProgressTimer(job: Job): void {
    if (job.progressTimer) {
      clearTimeout(job.progressTimer)
      job.progressTimer = undefined
    }
  }

  status(appId: string): UpdateStatus {
    const job = this.jobs.get(appId)
    return job ? { ...job.status, appId } : IDLE(appId)
  }

  async isUpdatingInstall(path: string): Promise<boolean> {
    const directory = await realDirectoryPath(path)
    return [...this.activeInstalls.values()].some((run) =>
      run.job.status.mode === 'update' && directoriesOverlap(run.directory, directory))
  }

  cancel(appId: string): void {
    this.jobs.get(appId)?.controller.abort()
  }

  async stopTasks(): Promise<void> {
    this.stopping = true
    for (const stop of this.stopSimulation.values()) stop()
    const runs = [...this.activeInstalls.values()]
    for (const run of runs) run.job.controller.abort(new Error('已取消'))
    await Promise.all(runs.map(run => run.finished))
    await this.clearHoYoContexts()
  }

  resumeTasks(): void {
    this.stopping = false
  }

  async start(appId: string, mode: UpdateMode, game: GachaGame, gameDir: string): Promise<void> {
    if (this.stopping) throw new Error('启动器正在退出')
    let existing = this.jobs.get(appId)
    // Resuming a simulated preview keeps simulating.
    if (existing?.simulated) {
      this.simulate(appId, mode, existing.simulatedStopAt)
      return
    }
    if (!gameDir.trim()) throw new Error('请先设置游戏安装目录')
    const actualDirectory = await realDirectoryPath(resolve(gameDir))
    if (isFileSystemRoot(actualDirectory)) throw new Error('不能更新磁盘根目录')
    const directory = actualDirectory.toLowerCase()
    while (!this.stopping) {
      const conflict = [...this.activeInstalls.values()].find(run => directoriesOverlap(run.directory, directory))
      if (conflict && (conflict.directory !== directory || conflict.game !== game)) {
        throw new Error('这个游戏目录与另一个正在更新的安装目录重叠')
      }
      const run = conflict ?? (game === 'arknights' ? undefined :
        [...this.activeInstalls.values()].find(item => item.game === game))
      if (!run) break
      if (run.directory === directory && run.job.status.mode === mode && !run.job.controller.signal.aborted) {
        this.jobs.set(appId, run.job)
        this.emit(run.job.status)
        return run.finished
      }
      run.job.controller.abort(new Error('已取消'))
      await run.finished
    }
    if (this.stopping) throw new Error('启动器正在退出')
    existing = this.jobs.get(appId)
    if (existing && (existing.status.phase === 'downloading' || existing.status.phase === 'extracting')) {
      throw new Error('已有更新任务在进行中')
    }

    const controller = new AbortController()
    const status: UpdateStatus = {
      appId,
      taskId: randomUUID(),
      phase: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      mode,
      message: mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    }
    const job: Job = { controller, status, lastProgressEmit: 0, installation: { game, directory } }
    for (const [otherId, previous] of this.jobs) {
      if (previous.installation?.game === game && previous.installation.directory === directory) {
        this.jobs.set(otherId, job)
      }
    }
    let release!: () => void
    const finished = new Promise<void>(done => { release = done })
    const runId = status.taskId!
    this.activeInstalls.set(runId, { job, game, directory, finished })
    this.jobs.set(appId, job)
    try {
      this.emit(status)
      log(`update: start ${mode} for ${appId} (${this.jobs.size} job(s) running)`)
      if (game === 'arknights') {
        await this.runArknights(mode, actualDirectory, controller, status)
      } else {
        await this.runHoYo(appId, mode, game, actualDirectory, controller, status)
      }
      this.clearProgressTimer(job)
      status.phase = 'done'
      status.progress = 1
      this.emit(status)
    } catch (error) {
      this.clearProgressTimer(job)
      // A user cancellation is a pause, not an error.
      if (controller.signal.aborted) {
        status.phase = 'paused'
        status.message = '已暂停'
        this.emit(status)
        log(`update: ${mode} paused for ${appId}`)
      } else {
        status.phase = 'error'
        status.message = (error as Error).message
        this.emit(status)
        log(`update: ${mode} failed for ${appId}: ${(error as Error).message}`)
      }
    } finally {
      this.activeInstalls.delete(runId)
      release()
    }
  }

  /**
   * Broadcast a fake download so the home-screen progress UI can be previewed
   * without a real update. Runs for as long as it takes to "reach" the total.
   */
  simulate(appId: string, mode: UpdateMode, stopAt?: number): void {
    if (!trialBuild) return
    if (this.stopping) throw new Error('启动器正在退出')
    this.stopSimulation.get(appId)?.()
    const total = 7.4 * 1024 ** 3
    const existing = this.jobs.get(appId)
    const startBytes = existing?.status.totalBytes === total ? existing.status.downloadedBytes : 0
    const controller = new AbortController()
    const status: UpdateStatus = {
      appId,
      taskId: randomUUID(),
      phase: 'downloading',
      progress: total > 0 ? startBytes / total : 0,
      downloadedBytes: startBytes,
      totalBytes: total,
      mode,
      message: mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    }
    const job: Job = {
      controller,
      status,
      simulated: true,
      simulatedStopAt: stopAt ?? existing?.simulatedStopAt,
      lastProgressEmit: 0
    }
    this.jobs.set(appId, job)
    this.emit(status)
    log(`update: simulate ${mode} for ${appId} (${this.jobs.size} job(s) running)`)

    const timer = setInterval(() => {
      if (controller.signal.aborted) {
        stop()
        return
      }
      const speed = (26 + Math.random() * 22) * 1024 * 1024 // ~26–48 MB/s
      status.downloadedBytes = Math.min(total, status.downloadedBytes + speed)
      status.progress = status.downloadedBytes / total
      this.emit(status)
      // Optional one-shot auto-pause (used to stage a "half finished" preview).
      if (job.simulatedStopAt && status.progress >= job.simulatedStopAt) {
        job.simulatedStopAt = undefined
        stop()
        return
      }
      if (status.downloadedBytes >= total) {
        clearInterval(timer)
        this.stopSimulation.delete(appId)
        status.phase = 'done'
        status.progress = 1
        this.emit(status)
      }
    }, PROGRESS_INTERVAL_MS)
    const stop = (): void => {
      clearInterval(timer)
      this.stopSimulation.delete(appId)
      status.phase = 'paused'
      status.message = '已暂停'
      this.emit(status)
    }
    this.stopSimulation.set(appId, stop)
  }

  private async downloadList(
    files: { url: string; name: string; size: number; md5?: string; dest: string }[],
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const total = files.reduce((sum, file) => sum + file.size, 0)
    status.totalBytes = total
    let base = 0
    for (const file of files) {
      log(`update: download ${file.name} (${Math.round(file.size / 1048576)} MB)`)
      await downloadFile({
        url: file.url,
        dest: file.dest,
        expectedSize: file.size,
        expectedMd5: file.md5,
        signal: controller.signal,
        onProgress: (downloaded) => {
          status.downloadedBytes = base + downloaded
          status.progress = total > 0 ? Math.min(1, (base + downloaded) / total) : 0
          this.emitProgress(status)
        }
      })
      base += file.size
    }
  }

  private readonly hoyoContexts = new Map<HoYoGame, HoYoContext>()

  private async wakeContext(context: HoYoContext): Promise<void> {
    clearTimeout(context.parkTimer)
    context.parkTimer = undefined
    await context.parked
    context.parked = undefined
  }

  async clearHoYoContexts(): Promise<void> {
    const contexts = [...this.hoyoContexts.values()]
    this.hoyoContexts.clear()
    await Promise.all(contexts.map(async context => {
      await this.wakeContext(context)
      await context.steps.close()
    }))
  }

  private async runHoYo(_appId: string, mode: UpdateMode, game: HoYoGame, gameDir: string,
    controller: AbortController, status: UpdateStatus): Promise<void> {
    const directory = resolve(gameDir).toLowerCase()
    const userData = app.getPath('userData')
    const launcherVersion = currentAppVersion()
    const { signal } = controller
    const progress = (done: number, total: number): void => {
      status.downloadedBytes = done
      status.totalBytes = total
      status.progress = total > 0 ? Math.min(1, done / total) : 0
      this.emitProgress(status)
    }
    const phase = (message: string, extracting = false): void => {
      status.phase = extracting ? 'extracting' : 'downloading'
      status.message = message
      this.emit(status)
    }
    await withHoYoNetwork(userData, 'runner', async () => {
      let context = this.hoyoContexts.get(game)
      if (context) await this.wakeContext(context)
      if (context && (context.directory !== directory || context.mode !== mode)) {
        this.hoyoContexts.delete(game)
        await context.steps.close()
        context = undefined
      }
      if (!context) {
        const hpatchz = app.isPackaged ? join(process.resourcesPath, 'hpatchz.exe') : join(app.getAppPath(), 'resources', 'hpatchz.exe')
        const steps = await prepareHoYoJob(game, gameDir, mode, { userData, launcherVersion, hpatchz, worker: sophonWorkerPath }, signal)
        context = { directory, mode, steps }
        this.hoyoContexts.set(game, context)
      }
      try {
        await context.steps.run({ signal, progress, phase })
      } catch (error) {
        if (error instanceof HoYoWorkerStopped) {
          this.hoyoContexts.delete(game)
          await context.steps.close()
        } else if (!this.stopping) {
          const suspended = context
          suspended.parkTimer = setTimeout(() => {
            suspended.parked = suspended.steps.park().catch(error =>
              log('update: could not release paused preparation: ' + String(error)))
          }, PARK_DELAY_MS)
          suspended.parkTimer.unref()
        }
        throw error
      }
      this.hoyoContexts.delete(game)
      await context.steps.close()
      status.message = mode === 'update' ? '更新完成' : '预下载完成'
    }, launcherVersion)
  }
  private async runWorker(
    workerPath: string,
    startMessage: Record<string, unknown>,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    controller.signal.throwIfAborted()
    const worker = createDownloadWorker(workerPath)
    const onAbort = (): void => worker.postMessage({ type: 'cancel' })
    controller.signal.addEventListener('abort', onAbort)

    try {
      await new Promise<void>((resolve, reject) => {
        let completed = false
        let failure: Error | undefined
        worker.on('message', (message: {
          type: string
          downloaded?: number
          total?: number
          message?: string
        }) => {
          if (message.type === 'progress') {
            status.downloadedBytes = message.downloaded ?? 0
            status.totalBytes = message.total ?? 0
            status.progress =
              message.total && message.total > 0
                ? Math.min(1, (message.downloaded ?? 0) / message.total)
                : 0
            this.emitProgress(status)
          } else if (message.type === 'extracting') {
            status.phase = 'extracting'
            status.progress = 0
            status.downloadedBytes = 0
            status.totalBytes = 0
            status.message = message.message ?? '正在应用更新…'
            this.emit(status)
          } else if (message.type === 'phase') {
            status.message = message.message ?? status.message
            this.emit(status)
          } else if (message.type === 'done') {
            completed = true
          } else if (message.type === 'error') {
            failure = new Error(message.message ?? '下载失败')
          }
        })
        worker.on('error', (error) => { failure = error })
        worker.on('exit', (code) => {
          if (failure) reject(failure)
          else if (code !== 0 || !completed) reject(new Error(`下载进程未正常完成 (${code})`))
          else resolve()
        })
        try { worker.postMessage(startMessage) }
        catch (error) {
          failure = error as Error
          void worker.terminate()
        }
      })
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private async runArknights(
    mode: UpdateMode,
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const { signal } = controller
    if (await arknightsRecoveryPending(gameDir)) {
      if (mode !== 'update') throw new Error('请先完成上次中断的明日方舟更新')
      await this.runWorker(arknightsWorkerPath, { type: 'recover', gameDir }, controller, status)
      status.message = '已完成上次中断的更新'
      return
    }
    const local = await readLocalVersion(gameDir)
    if (!local) throw new Error('无法识别明日方舟客户端，请选择已安装的游戏目录')
    if (mode === 'preDownload') {
      await this.runArknightsPredownload(gameDir, local, controller, status)
      return
    }
    const latest = await getArknightsLatest(local, signal)
    if (latest.action !== 1) {
      status.message = '已是最新版本'
      return
    }

    // Preferred path: the incremental ("v2") package — ~0.8 GB instead of the
    // full game package (tens of GB).
    if (latest.patch) {
      // A completed predownload for this exact version is reused, so the formal
      // update never downloads the same parts twice.
      const staged = await readAkPredownloadState(gameDir, latest.version)
      const preStagedDir =
        staged?.ready && staged.version === latest.version
          ? await arknightsPath(gameDir, `_kl_pre/${staged.version}`)
          : undefined
      log(
        `update: arknights delta ${local}→${latest.version} (` +
          `${Math.round(latest.patch.size / 1048576)} MB, ${latest.patch.parts.length} part(s)` +
          `${preStagedDir ? ', reusing predownload' : ''})`
      )
      status.phase = 'downloading'
      status.progress = 0
      status.message = '正在下载更新…'
      this.emit(status)

      const hpatchzPath = app.isPackaged
        ? join(process.resourcesPath, 'hpatchz.exe')
        : join(app.getAppPath(), 'resources', 'hpatchz.exe')
      await this.runWorker(
        arknightsWorkerPath,
        {
          type: 'start',
          gameDir,
          targetVersion: latest.version,
          patch: latest.patch,
          hpatchzPath,
          preStagedDir
        },
        controller,
        status
      )
      status.message = '更新完成'
      return
    }

    if (latest.packs.length === 0) {
      throw new Error('暂无可用更新包（请使用官方启动器更新）')
    }

    const directory = await arknightsPackageDirectory(gameDir, latest.version, 'full', latest.packs)
    const files = await Promise.all(latest.packs.map(async (pack: AkPack) =>
      ({ ...pack, dest: await arknightsPath(directory, pack.name) })))
    for (const file of files) {
      signal.throwIfAborted()
      await cacheArknightsVolume(await arknightsPath(gameDir, `Diffs/${file.name}`), file.dest, file)
    }
    const archives = arknightsFullVolumes(files.map(file => file.dest), files.map(file => file.name))
    await requireDiskSpace([{ path: directory, bytes: await missingVolumeBytes(directory, latest.packs) }])
    await this.downloadList(files, controller, status)
    const stageRoot = await akStageRoot(gameDir)
    const stage = await akStageFiles(gameDir)
    try {
      let bytes = 0
      for (const archive of archives) bytes += await gameArchiveBytes(archive, stage, signal)
      await requireDiskSpace([{ path: stage, bytes }])
      await fs.rm(stageRoot, { recursive: true, force: true })
      await fs.mkdir(stage, { recursive: true })
      status.phase = 'extracting'
      status.progress = 0
      status.message = '正在解压到更新暂存目录…'
      this.emit(status)
      for (const archive of archives) await extractHoYoArchive(archive, stage, signal)
      if (await readLocalVersion(stage) !== latest.version) throw new Error('更新包中的游戏版本与目标版本不符')
      await createArknightsCommit(gameDir, latest.version, [], signal, { packageDir: directory })
      status.message = '正在提交已验证的游戏文件…'
      this.emit(status)
      await finishArknightsCommit(gameDir, signal, (completed, total) => {
        status.progress = total ? completed / total : 0
        this.emitProgress(status)
      })
    } finally {
      if (!await arknightsRecoveryPending(gameDir)) await fs.rm(stageRoot, { recursive: true, force: true })
    }
    status.message = '更新完成'
  }

  /**
   * Arknights pre-download: fetch the `pre_patch` volumes into
   * `<gameDir>/_kl_pre/<version>` and record their state. The game directory is
   * not touched; the formal update later reuses these files.
   */
  private async runArknightsPredownload(
    gameDir: string,
    local: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const { signal } = controller
    const latest = await getArknightsLatest(local, signal)
    const pre = latest.prePatch
    if (!pre || !pre.version) throw new Error('当前没有可预下载的版本')
    if (local && compareVersions(local, pre.version) >= 0) {
      status.message = '已是最新版本'
      return
    }
    validateArknightsPackages(pre.parts)
    const dir = await arknightsPath(gameDir, `_kl_pre/${arknightsFileName(pre.version)}`)
    await requireDiskSpace([{ path: dir, bytes: await missingVolumeBytes(dir, pre.parts) }])
    await fs.mkdir(dir, { recursive: true })
    status.phase = 'downloading'
    status.progress = 0
    status.message = `正在预下载 ${pre.version}…`
    this.emit(status)
    await this.downloadList(
      await Promise.all(pre.parts.map(async (part) => ({ ...part, dest: await arknightsPath(dir, part.name) }))),
      controller,
      status
    )
    signal.throwIfAborted()
    await writeAkPredownloadState(gameDir, {
      version: pre.version,
      ready: true,
      total: pre.size,
      parts: pre.parts.map((part) => ({ name: part.name, size: part.size, md5: part.md5 }))
    })
    status.message = '预下载完成'
    log(`update: arknights predownload ${pre.version} ready (${pre.parts.length} part(s))`)
  }
}
