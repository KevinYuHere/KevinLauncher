import { createWriteStream, createReadStream, promises as fs } from 'fs'
import { get as httpsGet } from 'https'
import { get as httpGet } from 'http'
import { createHash } from 'crypto'
import { dirname } from 'path'
import type { IncomingMessage } from 'http'

export interface DownloadOptions {
  url: string
  dest: string
  expectedSize?: number
  expectedMd5?: string
  onProgress?: (downloaded: number, total: number) => void
  signal?: AbortSignal
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}

async function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Download a file to `dest`, resuming from a partial file when possible and
 * verifying the MD5 afterwards. Emits progress via `onProgress`.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  await fs.mkdir(dirname(options.dest), { recursive: true })

  let start = await fileSize(options.dest)
  if (options.expectedSize && start === options.expectedSize) {
    if (!options.expectedMd5 || (await md5File(options.dest)) === options.expectedMd5) return
    start = 0
    await fs.rm(options.dest, { force: true })
  }

  const headers: Record<string, string> = {}
  if (start > 0) headers['Range'] = `bytes=${start}-`

  await new Promise<void>((resolve, reject) => {
    const getter = options.url.startsWith('http:') ? httpGet : httpsGet
    const request = getter(options.url, { headers }, (res: IncomingMessage) => {
      if (res.statusCode === 416) {
        res.resume()
        resolve()
        return
      }
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
        res.resume()
        reject(new Error(`下载失败：HTTP ${res.statusCode}`))
        return
      }
      const contentLength = Number(res.headers['content-length'] ?? 0)
      const total = options.expectedSize ?? start + contentLength
      const stream = createWriteStream(options.dest, { flags: start > 0 ? 'a' : 'w' })
      let downloaded = start
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        options.onProgress?.(downloaded, total)
      })
      res.on('error', reject)
      stream.on('error', reject)
      stream.on('finish', () => resolve())
      res.pipe(stream)
    })
    request.on('error', reject)
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        request.destroy()
        reject(new Error('已取消'))
      })
    }
  })

  if (options.expectedMd5) {
    const actual = await md5File(options.dest)
    if (actual !== options.expectedMd5) throw new Error('文件校验失败（MD5 不匹配）')
  }
}
