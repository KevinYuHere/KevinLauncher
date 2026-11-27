import { promises as fs } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { md5File } from './hash'
import { createThrottleTransform } from './rateLimit'
import { openWritableGameFile } from './writableGameFile'

export interface DownloadOptions {
  url: string
  dest: string
  expectedSize?: number
  expectedMd5?: string
  onProgress?: (downloaded: number, total: number) => void
  signal?: AbortSignal
  timeoutMs?: number
}

class WrongLength extends Error {}

async function fileSize(path: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载目标不是普通文件：' + path)
    return stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function numberHeader(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function responseFor(url: URL, start: number, options: DownloadOptions, redirects = 0): Promise<IncomingMessage> {
  options.signal?.throwIfAborted()
  if (!['http:', 'https:'].includes(url.protocol) || redirects > 5) throw new Error('下载地址或重定向无效')
  const get = url.protocol === 'https:' ? httpsGet : httpGet
  const timeout = options.timeoutMs ?? 30_000
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {}
    const request = get(url, { headers, signal: options.signal }, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
    const timer = setTimeout(() => request.destroy(new Error('等待下载响应超时')), timeout)
    request.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
  if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
    res.destroy()
    if (!res.headers.location) throw new Error('下载重定向缺少目标地址')
    return responseFor(new URL(res.headers.location, url), start, options, redirects + 1)
  }
  res.setTimeout(timeout, () => res.destroy(new Error('下载响应体停止传输')))
  return res
}

/** Validate an existing complete file before using it as a cache hit. */
export async function verifiedDownload(path: string, size?: number, md5?: string): Promise<boolean> {
  const actual = await fileSize(path)
  return actual !== null && (size === undefined || actual === size) &&
    (md5 ? (await md5File(path)).toLowerCase() === md5.toLowerCase() : size !== undefined)
}

/** Resume a partial transfer, verify it and publish the final file atomically. */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { dest, signal } = options
  const part = dest + '.part'
  const expectedSize = options.expectedSize === 0 ? undefined : options.expectedSize
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error('下载包大小无效')
  }
  signal?.throwIfAborted()
  const legacy = await fileSize(dest)
  if (legacy !== null && await verifiedDownload(dest, expectedSize, options.expectedMd5)) {
    options.onProgress?.(legacy, legacy)
    return
  }
  let partSize = await fileSize(part)
  await fs.mkdir(dirname(dest), { recursive: true })
  if (legacy !== null) {
    if (partSize === null && expectedSize !== undefined && legacy < expectedSize) {
      await fs.rename(dest, part)
      partSize = legacy
    } else await fs.unlink(dest)
  }
  if (partSize !== null && await verifiedDownload(part, expectedSize, options.expectedMd5)) {
    signal?.throwIfAborted()
    await fs.rename(part, dest)
    options.onProgress?.(partSize, partSize)
    return
  }
  let start = partSize ?? 0
  if (expectedSize !== undefined && start >= expectedSize) start = 0
  let total = expectedSize
  let restarted = false
  for (;;) {
    const response = await responseFor(new URL(options.url), start, options)
    if (response.statusCode === 416) {
      response.destroy()
      const reported = numberHeader(/^bytes \*\/(\d+)$/.exec(response.headers['content-range'] ?? '')?.[1])
      if (reported !== null && start === reported && (total === undefined || reported === total) &&
          await verifiedDownload(part, reported, options.expectedMd5)) {
        total = reported
        break
      }
      if (start === 0 || restarted) throw new Error('服务端拒绝下载范围')
      restarted = true
      start = 0
      continue
    }
    let goal: number | undefined
    const contentLength = numberHeader(response.headers['content-length'])
    if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '')
      const first = numberHeader(range?.[1])
      const last = numberHeader(range?.[2])
      const full = numberHeader(range?.[3])
      if (first !== start || last === null || full === null || last < first || last >= full ||
          (total !== undefined && total !== full) || (contentLength !== null && contentLength !== last - first + 1)) {
        response.destroy()
        throw new Error('下载响应范围无效')
      }
      total = full
      goal = last + 1
    } else if (response.statusCode === 200) {
      start = 0
      if (total !== undefined && contentLength !== null && contentLength !== total) {
        response.destroy()
        throw new Error('下载响应长度与清单不符')
      }
      total ??= contentLength ?? undefined
      goal = total
    } else {
      response.destroy()
      throw new Error(`下载失败：HTTP ${response.statusCode ?? 'unknown'}`)
    }
    let written = start
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length
        if (goal !== undefined && written > goal) {
          callback(new WrongLength('下载文件超过声明长度'))
          return
        }
        options.onProgress?.(written, total ?? 0)
        callback(null, chunk)
      }
    })
    try {
      const handle = await openWritableGameFile(part)
      try {
        if (start === 0) await handle.truncate(0)
      } catch (error) {
        await handle.close()
        throw error
      }
      await pipeline(response, createThrottleTransform(), count, handle.createWriteStream({ start }), { signal })
    } catch (error) {
      response.destroy()
      if (error instanceof WrongLength) await fs.rm(part, { force: true })
      throw error
    }
    if (goal !== undefined && written !== goal) throw new Error('下载文件长度不足，已保留续传数据')
    if (total === undefined || written === total) break
    start = written
  }
  signal?.throwIfAborted()
  const completedSize = await fileSize(part)
  if (completedSize === null || (total !== undefined && completedSize !== total)) {
    throw new Error('下载文件缺失或长度不符')
  }
  if (options.expectedMd5 && !await verifiedDownload(part, completedSize, options.expectedMd5)) {
    await fs.rm(part, { force: true })
    throw new Error('文件校验失败（MD5 不匹配）')
  }
  signal?.throwIfAborted()
  await fs.rename(part, dest)
  options.onProgress?.(completedSize, total ?? completedSize)
}
