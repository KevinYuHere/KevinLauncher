import { app } from 'electron'
import { dirname, join } from 'path'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pipeline } from 'stream/promises'
import type { GachaGame, UpdateMode, UpdateStatus } from '@shared/types'
import { downloadFile } from '../services/downloader'
import { writeFileAtomic } from '../services/atomicFile'
import {
  audioEnumNames,
  compareVersion,
  detectAudioLanguages,
  getGameBranches,
  getGameChannelSDK,
  getGameConfig,
  getGameDeprecatedFiles,
  getHoYoPackages,
  getWPFPackageVersion,
  readGameVersion
} from './hoyoplay'
import { getArknightsLatest, readLocalVersion, type AkPack } from './arknightsUpdate'
import sophonWorkerPath from '../workers/sophonWorker?modulePath'
import arknightsWorkerPath from '../workers/arknightsWorker?modulePath'
import { Worker } from 'worker_threads'
import { log } from '../services/logger'

const exec = promisify(execFile)

interface Job {
  controller: AbortController
  status: UpdateStatus
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
  private readonly listeners = new Set<(status: UpdateStatus) => void>()

  onProgress(callback: (status: UpdateStatus) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emit(status: UpdateStatus): void {
    for (const listener of this.listeners) listener({ ...status })
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
    const job: Job = { controller, status, lastProgressEmit: 0 }
    this.jobs.set(appId, job)
    this.emit(status)
    log(`update: start ${mode} for ${appId} (${this.jobs.size} job(s) running)`)

    try {
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

  private async runHoYo(
    appId: string,
    mode: UpdateMode,
    game: 'genshin' | 'starrail' | 'zzz',
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const gameConfig = await getGameConfig(game).catch(() => null)
    // Only the installed voice languages are downloaded (size differs per player).
    const audioLanguages = await detectAudioLanguages(gameDir)
    // Non-chunk games use the compressed-package flow (Starward: DefaultDownloadMode).
    const defaultMode = gameConfig?.defaultDownloadMode ?? ''
    if (
      defaultMode &&
      defaultMode !== 'DOWNLOAD_MODE_CHUNK' &&
      defaultMode !== 'DOWNLOAD_MODE_LDIFF'
    ) {
      await this.runHoYoPackage(appId, mode, game, gameDir, controller, status, audioLanguages)
      return
    }

    const branches = await getGameBranches(game)
    const target = mode === 'preDownload' ? branches.preDownload : branches.main
    if (!target) {
      throw new Error(mode === 'preDownload' ? '当前没有可预下载的版本' : '未找到更新分支')
    }

    const localVersion = await readGameVersion(gameDir)
    const hpatchzPath = app.isPackaged
      ? join(process.resourcesPath, 'hpatchz.exe')
      : join(app.getAppPath(), 'resources', 'hpatchz.exe')
    // Resource categories the game config marks as deleted are skipped (Starward
    // reads `res_category_launcher`; a missing file simply means "none").
    const ignoreFields = gameConfig?.resCategoryDir
      ? await readIgnoreFields(gameDir, gameConfig.resCategoryDir)
      : []
    const blacklist =
      gameConfig?.enableBlacklist && gameConfig.blacklistDir
        ? await readBlacklist(gameDir, gameConfig.blacklistDir)
        : []
    // Chunk/patch caches live inside the install dir (`chunk/`, `ldiff/`) so a run
    // interrupted mid-way resumes from them. Pre-download only fills the cache;
    // the formal update assembles the files from the local game + cache.
    status.phase = 'downloading'
    status.progress = 0
    status.message = mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    this.emit(status)

    await this.runWorker(
      sophonWorkerPath,
      {
        type: 'start',
        branch: target,
        destDir: gameDir,
        originDir: gameDir,
        mode,
        localVersion,
        hpatchzPath,
        audioLanguages,
        ignoreFields,
        blacklist,
        diffTags: target.diffTags
      },
      controller,
      status
    )

    if (mode === 'preDownload') {
      // Completion is recorded in the game's config.ini (`predownload=`); the
      // game_version stays unchanged until the formal update is applied.
      await writeConfigIni(gameDir, {
        predownload: `${localVersion},${target.tag},${audioEnumNames(audioLanguages)}`
      })
      status.message = '预下载完成'
    } else {
      // F29: delete files the official config marks as deprecated.
      for (const name of await getGameDeprecatedFiles(game)) {
        await fs.rm(join(gameDir, ...name.split('/')), { force: true }).catch(() => undefined)
      }
      // F32: hard-link audio from the cache dir into the resource dir.
      if (gameConfig?.enableAudioPkgMgmt && gameConfig.audioCacheDir && gameConfig.audioResDir) {
        await linkAudioFiles(gameDir, gameConfig.audioCacheDir, gameConfig.audioResDir).catch(
          () => undefined
        )
      }
      // F30: write the SDK / WPF versions the game expects.
      await writeConfigIni(gameDir, {
        gameVersion: target.tag,
        predownload: null,
        sdkVersion: await getGameChannelSDK(game),
        wpfVersion: await getWPFPackageVersion(game)
      })
      // Post-update verification: the game's config.ini must now report the target.
      const installed = await readGameVersion(gameDir)
      if (installed && compareVersion(installed, target.tag) !== 0) {
        log(`update: verification failed (config.ini ${installed} != ${target.tag})`)
      }
      status.message = '更新完成'
    }
  }
  /**
   * Compressed-package flow (games whose `DefaultDownloadMode` is not chunk).
   * Downloads the listed zips (game + installed voice languages), then extracts
   * them into the game dir; a pre-download stages the zips and the formal update
   * extracts them.
   */
  private async runHoYoPackage(
    appId: string,
    mode: UpdateMode,
    game: 'genshin' | 'starrail' | 'zzz',
    gameDir: string,
    controller: AbortController,
    status: UpdateStatus,
    audioLanguages: string[]
  ): Promise<void> {
    const pkgs = await getHoYoPackages(game)
    const target = mode === 'preDownload' ? pkgs.preDownload : pkgs.main
    if (!target) throw new Error(mode === 'preDownload' ? '当前没有可预下载的版本' : '未找到更新包')
    const files = target.files.filter(
      (file) => !file.language || audioLanguages.includes(file.language)
    )
    if (files.length === 0) throw new Error('没有可下载的安装包')
    const staging = join(app.getPath('userData'), 'predownload', appId, target.version)

    if (mode === 'update') {
      const state = await readPredownloadState(staging)
      if (state?.ready && state.mode === 'package' && state.version === target.version) {
        status.phase = 'extracting'
        status.progress = 0
        status.message = '正在应用预下载…'
        this.emit(status)
        await extractPackages(staging, gameDir)
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
        await writeConfigIni(gameDir, { gameVersion: target.version, predownload: null })
        status.message = '更新完成'
        return
      }
    }

    const work =
      mode === 'preDownload'
        ? staging
        : await fs.mkdtemp(join(app.getPath('userData'), 'update-pkg-'))
    await fs.mkdir(work, { recursive: true })
    status.phase = 'downloading'
    status.progress = 0
    status.message = mode === 'preDownload' ? '正在预下载…' : '正在下载更新…'
    this.emit(status)
    await this.downloadList(
      files.map((file) => ({
        url: file.url,
        name: file.name,
        size: file.size,
        md5: file.md5,
        dest: join(work, file.name)
      })),
      controller,
      status
    )
    if (mode === 'preDownload') {
      await writeFileAtomic(
        join(staging, 'state.json'),
        JSON.stringify({ version: target.version, ready: true, deletes: [], mode: 'package' }, null, 2)
      )
      status.message = '预下载完成'
      return
    }
    status.phase = 'extracting'
    status.progress = 0
    status.message = '正在应用更新（解压）…'
    this.emit(status)
    await extractPackages(work, gameDir)
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
    await writeConfigIni(gameDir, { gameVersion: target.version, predownload: null })
    status.message = '更新完成'
  }

  /**
   * Run a download/apply job in a worker thread, translating its messages into
   * `UpdateStatus` updates. Progress is throttled (see `emitProgress`) so the
   * UI updates about once per second instead of on every chunk.
   */
  private async runWorker(
    workerPath: string,
    startMessage: Record<string, unknown>,
    controller: AbortController,
    status: UpdateStatus
  ): Promise<void> {
    const worker = new Worker(workerPath)
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
    if (mode === 'preDownload') throw new Error('明日方舟不支持预下载')
    const local = await readLocalVersion(gameDir)
    const latest = await getArknightsLatest(local)
    if (latest.action !== 1) {
      status.message = '已是最新版本'
      return
    }

    // Preferred path: the incremental ("v2") package — ~0.8 GB instead of the
    // full game package (tens of GB).
    if (latest.patch) {
      log(
        `update: arknights delta ${local}→${latest.version} (` +
          `${Math.round(latest.patch.size / 1048576)} MB, ${latest.patch.parts.length} part(s))`
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
          hpatchzPath
        },
        controller,
        status
      )
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
}

/** Read `<res_category_dir>` lines (`{"category":"…","is_delete":true}`). */
async function readIgnoreFields(gameDir: string, relative: string): Promise<string[]> {
  try {
    const text = await fs.readFile(join(gameDir, ...relative.split('/')), 'utf-8')
    const fields: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { category?: string; is_delete?: boolean }
        if (obj?.is_delete && obj.category) fields.push(String(obj.category))
      } catch {
        /* ignore malformed lines */
      }
    }
    return fields
  } catch {
    return []
  }
}

async function readBlacklist(gameDir: string, relative: string): Promise<string[]> {
  try {
    const text = await fs.readFile(join(gameDir, ...relative.split('/')), 'utf-8')
    const files: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        const name = obj.fileName ?? obj.file_name ?? obj.filename ?? obj.name
        if (typeof name === 'string' && name) files.push(name)
      } catch {
        /* ignore malformed lines */
      }
    }
    return files
  } catch {
    return []
  }
}
/** Hard-link audio files from the cache dir into the resource dir (Starward F32). */
async function linkAudioFiles(installDir: string, cacheDir: string, resDir: string): Promise<void> {
  if (cacheDir.toLowerCase() === resDir.toLowerCase()) return
  const from = join(installDir, ...cacheDir.split('/'))
  const to = join(installDir, ...resDir.split('/'))
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const src = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(src, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      const dst = join(to, ...nextRel.split('/'))
      try {
        await fs.access(dst)
        continue
      } catch {
        /* target missing */
      }
      await fs.mkdir(dirname(dst), { recursive: true })
      try {
        await fs.link(src, dst)
      } catch {
        await fs.copyFile(src, dst).catch(() => undefined)
      }
    }
  }
  await walk(from, '')
}
interface PredownloadState {
  version?: string
  ready?: boolean
  deletes?: string[]
  /** `chunk` (patch/chunk staging) or `package` (compressed-package zips). */
  mode?: string
}

async function readPredownloadState(dir: string): Promise<PredownloadState | null> {
  try {
    return JSON.parse(await fs.readFile(join(dir, 'state.json'), 'utf-8')) as PredownloadState
  } catch {
    return null
  }
}

/** Edit the game's `config.ini` the way Starward does (last `game_version=`). */
async function writeConfigIni(
  gameDir: string,
  opts: {
    gameVersion?: string
    predownload?: string | null
    sdkVersion?: string | null
    wpfVersion?: string | null
  }
): Promise<void> {
  const file = join(gameDir, 'config.ini')
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return
  }
  // Starward drops the legacy [General] header line before rewriting keys.
  const lines = text.split(/\r?\n/).filter((line) => !/\[General\]/i.test(line))
  const setLine = (key: string, value: string | null): void => {
    const re = new RegExp(`^\\s*${key}\\s*=`)
    let index = -1
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) index = i
    if (value == null) {
      if (index >= 0) lines.splice(index, 1)
      return
    }
    const next = `${key}=${value}`
    if (index >= 0) lines[index] = next
    else lines.push(next)
  }
  if (opts.gameVersion !== undefined) setLine('game_version', opts.gameVersion)
  if (opts.predownload !== undefined) setLine('predownload', opts.predownload)
  if (opts.sdkVersion) setLine('sdk_version', opts.sdkVersion)
  if (opts.wpfVersion) setLine('wpf_version', opts.wpfVersion)
  // CN launcher channel fields (Starward writes these on every update).
  setLine('channel', '1')
  setLine('sub_channel', '1')
  setLine('cps', 'hyp_mihoyo')
  await writeFileAtomic(file, lines.join('\r\n'))
}

/** Extract every `.zip` in `dir` into the game dir (compressed-package flow). */
async function extractPackages(dir: string, gameDir: string): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    if (name.toLowerCase().endsWith('.zip')) await extractZip(join(dir, name), gameDir)
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
