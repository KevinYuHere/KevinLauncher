import { app } from 'electron'
import { join } from 'path'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pipeline } from 'stream/promises'
import type { GachaGame, UpdateMode, UpdateStatus } from '@shared/types'
import { downloadFile } from '../services/downloader'
import { getGameBranches, readGameVersion } from './hoyoplay'
import { getArknightsLatest, readLocalVersion, type AkPack } from './arknightsUpdate'
import sophonWorkerPath from '../workers/sophonWorker?modulePath'
import { Worker } from 'worker_threads'
import { log } from '../services/logger'

const exec = promisify(execFile)

interface Job {
  controller: AbortController
  status: UpdateStatus
  simulated?: boolean
  simulatedStopAt?: number
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
  private readonly listeners = new Set<(status: UpdateStatus) => void>()

  onProgress(callback: (status: UpdateStatus) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emit(status: UpdateStatus): void {
    for (const listener of this.listeners) listener({ ...status })
  }

  status(appId: string): UpdateStatus {
    return this.jobs.get(appId)?.status ?? IDLE(appId)
  }

  cancel(appId: string): void {
    this.jobs.get(appId)?.controller.abort()
  }

  async start(appId: string, mode: UpdateMode, game: GachaGame, gameDir: string): Promise<void> {
    const existing = this.jobs.get(appId)
    // Resuming a simulated preview keeps simulating.
    if (existing?.simulated) {
      this.simulate(appId, mode, existing.simulatedStopAt)
      return
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
    this.jobs.set(appId, { controller, status })
    this.emit(status)
    log(`update: start ${mode} for ${appId} (${this.jobs.size} job(s) running)`)

    try {
      if (game === 'arknights') {
        await this.runArknights(mode, gameDir, controller, status)
      } else {
        await this.runHoYo(appId, mode, game, gameDir, controller, status)
      }
      status.phase = 'done'
      status.progress = 1
      this.emit(status)
    } catch (error) {
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
    const job: Job = { controller, status, simulated: true, simulatedStopAt: stopAt ?? existing?.simulatedStopAt }
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
      status.downloadedBytes = Math.min(total, status.downloadedBytes + speed * 0.5)
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
    }, 500)
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
          this.emit(status)
        }
      })
      base += file.size
    }
  }

  private async runHoYo(
    appId: string,
    mode: UpdateMode,
    game: 'genshin' | 'starrail' | 'zzz',
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const branches = await getGameBranches(game)
    const target = mode === 'preDownload' ? branches.preDownload : branches.main
    if (!target) {
      throw new Error(mode === 'preDownload' ? '当前没有可预下载的版本' : '未找到更新分支')
    }

    // Pre-download goes to a staging directory; update is applied in place
    // (only changed files are downloaded — file-level incremental + resume).
    const destDir =
      mode === 'preDownload'
        ? join(app.getPath('userData'), 'predownload', appId, target.tag)
        : gameDir
    await fs.mkdir(destDir, { recursive: true })

    status.phase = 'downloading'
    status.progress = 0
    status.message = mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    this.emit(status)

    const localVersion = mode === 'update' ? await readGameVersion(gameDir) : ''
    const hpatchzPath = app.isPackaged
      ? join(process.resourcesPath, 'hpatchz.exe')
      : join(app.getAppPath(), 'resources', 'hpatchz.exe')

    // Reuse a (possibly partial) pre-download for this version if present.
    const predownloadDir = join(app.getPath('userData'), 'predownload', appId, target.tag)
    let promoteFrom: string | undefined
    if (mode === 'update') {
      try {
        await fs.access(predownloadDir)
        promoteFrom = predownloadDir
      } catch {
        /* no pre-download */
      }
    }

    // The heavy download/decompress/assembly runs in a worker thread so the
    // main process (and the UI) never blocks.
    const worker = new Worker(sophonWorkerPath)
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
        worker.postMessage({
          type: 'start',
          branch: target,
          destDir,
          mode,
          skipUnchanged: true,
          localVersion,
          hpatchzPath,
          promoteFrom
        })
      })
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      void worker.terminate()
    }

    if (mode === 'preDownload') {
      await fs.writeFile(
        join(destDir, 'state.json'),
        JSON.stringify({ version: target.tag, ready: true, finishedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      )
    }
    status.message = mode === 'preDownload' ? '预下载完成' : '更新完成'
  }

  private async runArknights(
    mode: UpdateMode,
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    if (mode === 'preDownload') throw new Error('明日方舟不支持预下载')
    const local = await readLocalVersion(gameDir)
    const latest = await getArknightsLatest(local)
    if (latest.action !== 1) {
      status.message = '已是最新版本'
      return
    }
    if (latest.packs.length === 0) {
      status.message = '暂无可用更新包（请使用官方启动器更新）'
      return
    }

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
