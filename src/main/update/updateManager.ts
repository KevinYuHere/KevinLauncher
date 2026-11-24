import { app } from 'electron'
import { join, resolve } from 'path'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pipeline } from 'stream/promises'
import type { GachaGame, UpdateMode, UpdateStatus } from '@shared/types'
import { compareVersions } from '@shared/version'
import { downloadFile } from '../services/downloader'
import type { HoYoGame } from './hoyoplay'
import { prepareHoYoJob } from './hoyoJob'
import { HoYoWorkerStopped } from './hoyoWorker'
import type { HoYoSteps } from './hoyoSchedule'
import { withHoYoNetwork } from './hoyoNetwork'
import { currentAppVersion } from '../services/appVersion'
import {
  akPredownloadDir,
  clearAkPredownload,
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

const exec = promisify(execFile)

interface Job {
  controller: AbortController
  status: UpdateStatus
  installation?: { game: HoYoGame; directory: string }
  simulated?: boolean
  simulatedStopAt?: number
  /** Timestamp of the last progress broadcast (download throttling). */
  lastProgressEmit: number
  /** Pending trailing broadcast that guarantees the newest value is shown. */
  progressTimer?: ReturnType<typeof setTimeout>
}

/** Progress broadcasts are throttled to this interval so the UI can be read. */
const PROGRESS_INTERVAL_MS = 1000

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
  private readonly activeHoYo = new Map<HoYoGame, { job: Job; directory: string; finished: Promise<void> }>()
  private stoppingHoYo = false
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

  cancel(appId: string): void {
    this.jobs.get(appId)?.controller.abort()
  }

  async stopHoYoTasks(): Promise<void> {
    this.stoppingHoYo = true
    const runs = [...this.activeHoYo.values()]
    for (const run of runs) run.job.controller.abort()
    await Promise.all(runs.map(run => run.finished))
    await this.clearHoYoContexts()
  }

  async start(appId: string, mode: UpdateMode, game: GachaGame, gameDir: string): Promise<void> {
    let existing = this.jobs.get(appId)
    // Resuming a simulated preview keeps simulating.
    if (existing?.simulated) {
      this.simulate(appId, mode, existing.simulatedStopAt)
      return
    }
    const directory = resolve(gameDir).toLowerCase()
    if (game !== 'arknights') {
      while (!this.stoppingHoYo) {
        const run = this.activeHoYo.get(game)
        if (!run) break
        if (run.directory === directory && run.job.status.mode === mode && !run.job.controller.signal.aborted) {
          this.jobs.set(appId, run.job)
          this.emit(run.job.status)
          return run.finished
        }
        // A different path or operation supersedes the game context upstream.
        run.job.controller.abort()
        await run.finished
      }
      if (this.stoppingHoYo) throw new Error('启动器正在退出')
      existing = this.jobs.get(appId)
    }
    if (existing && (existing.status.phase === 'downloading' || existing.status.phase === 'extracting')) {
      throw new Error('已有更新任务在进行中')
    }

    const controller = new AbortController()
    const status: UpdateStatus = {
      appId,
      phase: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      mode,
      message: mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    }
    const job: Job = { controller, status, lastProgressEmit: 0 }
    let release: (() => void) | undefined
    if (game !== 'arknights') {
      job.installation = { game, directory }
      for (const [otherId, previous] of this.jobs) {
        if (previous.installation?.game === game && previous.installation.directory === directory) {
          this.jobs.set(otherId, job)
        }
      }
      const finished = new Promise<void>(done => { release = done })
      this.activeHoYo.set(game, { job, directory, finished })
    }
    this.jobs.set(appId, job)
    try {
      this.emit(status)
      log(`update: start ${mode} for ${appId} (${this.jobs.size} job(s) running)`)
      if (game === 'arknights') {
        await this.runArknights(mode, gameDir, controller, status)
      } else {
        await this.runHoYo(appId, mode, game, gameDir, controller, status)
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
      if (game !== 'arknights') this.activeHoYo.delete(game)
      release?.()
    }
  }

  /**
   * Broadcast a fake download so the home-screen progress UI can be previewed
   * without a real update. Runs for as long as it takes to "reach" the total.
   */
  simulate(appId: string, mode: UpdateMode, stopAt?: number): void {
    const total = 7.4 * 1024 ** 3
    const existing = this.jobs.get(appId)
    const startBytes = existing?.status.totalBytes === total ? existing.status.downloadedBytes : 0
    const controller = new AbortController()
    const status: UpdateStatus = {
      appId,
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
        clearInterval(timer)
        status.phase = 'paused'
        status.message = '已暂停'
        this.emit(status)
        return
      }
      const speed = (26 + Math.random() * 22) * 1024 * 1024 // ~26–48 MB/s
      status.downloadedBytes = Math.min(total, status.downloadedBytes + speed)
      status.progress = status.downloadedBytes / total
      this.emit(status)
      // Optional one-shot auto-pause (used to stage a "half finished" preview).
      if (job.simulatedStopAt && status.progress >= job.simulatedStopAt) {
        clearInterval(timer)
        job.simulatedStopAt = undefined
        status.phase = 'paused'
        status.message = '已暂停'
        this.emit(status)
        return
      }
      if (status.downloadedBytes >= total) {
        clearInterval(timer)
        status.phase = 'done'
        status.progress = 1
        this.emit(status)
      }
    }, PROGRESS_INTERVAL_MS)
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

  private readonly hoyoContexts = new Map<HoYoGame, { directory: string; mode: UpdateMode; steps: HoYoSteps }>()

  async clearHoYoContexts(): Promise<void> {
    const contexts = [...this.hoyoContexts.values()]
    this.hoyoContexts.clear()
    await Promise.all(contexts.map(context => context.steps.close()))
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
    const worker = createDownloadWorker(workerPath)
    const onAbort = (): void => worker.postMessage({ type: 'cancel' })
    controller.signal.addEventListener('abort', onAbort)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          fn()
        }
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
            finish(resolve)
          } else if (message.type === 'error') {
            finish(() => reject(new Error(message.message ?? '下载失败')))
          }
        })
        worker.on('error', (error) => finish(() => reject(error)))
        worker.on('exit', (code) => {
          if (code !== 0) finish(() => reject(new Error(`下载进程异常退出 (${code})`)))
        })
        worker.postMessage(startMessage)
      })
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      void worker.terminate()
    }
  }

  private async runArknights(
    mode: UpdateMode,
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    if (mode === 'preDownload') {
      await this.runArknightsPredownload(gameDir, controller, status)
      return
    }
    const local = await readLocalVersion(gameDir)
    const latest = await getArknightsLatest(local)
    if (latest.action !== 1) {
      status.message = '已是最新版本'
      return
    }

    // Preferred path: the incremental ("v2") package — ~0.8 GB instead of the
    // full game package (tens of GB).
    if (latest.patch) {
      // A completed predownload for this exact version is reused, so the formal
      // update never downloads the same parts twice.
      const staged = await readAkPredownloadState(gameDir)
      const preStagedDir =
        staged?.ready && staged.version === latest.version
          ? akPredownloadDir(gameDir, staged.version)
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
      await clearAkPredownload(gameDir)
      status.message = '更新完成'
      return
    }

    if (latest.packs.length === 0) {
      status.message = '暂无可用更新包（请使用官方启动器更新）'
      return
    }

    // Fallback: full package (fresh installs / servers without a delta).
    const diffDir = join(gameDir, 'Diffs')
    await fs.mkdir(diffDir, { recursive: true })

    await this.downloadList(
      latest.packs.map((pack: AkPack) => ({ ...pack, dest: join(diffDir, pack.name) })),
      controller,
      status
    )

    status.phase = 'extracting'
    status.progress = 0
    status.message = '正在应用更新（解压）…'
    this.emit(status)
    await extractVolumes(diffDir, gameDir)
    try {
      await fs.rm(diffDir, { recursive: true, force: true })
    } catch {
      /* keep downloaded archives on failure */
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
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const local = await readLocalVersion(gameDir)
    const latest = await getArknightsLatest(local)
    const pre = latest.prePatch
    if (!pre || !pre.version) throw new Error('当前没有可预下载的版本')
    if (local && compareVersions(local, pre.version) >= 0) {
      status.message = '已是最新版本'
      return
    }
    const dir = akPredownloadDir(gameDir, pre.version)
    await fs.mkdir(dir, { recursive: true })
    status.phase = 'downloading'
    status.progress = 0
    status.message = `正在预下载 ${pre.version}…`
    this.emit(status)
    await this.downloadList(
      pre.parts.map((part) => ({ ...part, dest: join(dir, part.name) })),
      controller,
      status
    )
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




/** Extract a single zip archive into `dest` using Windows' bundled bsdtar. */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  await exec('tar', ['-xf', zipPath, '-C', dest], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

/**
 * Extract every archive in `dir`, merging split volumes (`*.zip.001`, `.002`,
 * …) into a single zip first. Used for both miHoYo and Arknights packages.
 */
async function extractVolumes(dir: string, gameDir: string): Promise<void> {
  const files = await fs.readdir(dir)
  const splitBases = new Map<string, string[]>()
  const singles: string[] = []
  for (const name of files) {
    const match = /^(.*\.zip)\.(\d{3})$/.exec(name)
    if (match) {
      const list = splitBases.get(match[1]) ?? []
      list.push(name)
      splitBases.set(match[1], list)
    } else if (name.toLowerCase().endsWith('.zip')) {
      singles.push(name)
    }
  }

  for (const [base, parts] of splitBases) {
    parts.sort()
    const merged = join(dir, base)
    await fs.rm(merged, { force: true })
    for (const part of parts) {
      await pipeline(createReadStream(join(dir, part)), createWriteStream(merged, { flags: 'a' }))
    }
    await extractZip(merged, gameDir)
  }
  for (const single of singles) {
    await extractZip(join(dir, single), gameDir)
  }
}
