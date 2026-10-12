import { createReadStream, promises as fs } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/**
 * Serves a local file to the renderer's `kevin-media://` protocol with the right
 * MIME type and **HTTP Range** support.
 *
 * Range support is essential for `<video>`: without `206 Partial Content`
 * responses Chromium's demuxer intermittently fails to open large MP4s
 * (`DEMUXER_ERROR_COULD_NOT_OPEN` → a black background). CORS is added so the
 * renderer can also draw these files to a canvas (untainted).
 */
export async function serveMediaFile(filePath: string, request: Request): Promise<Response> {
  let size: number
  try {
    size = (await fs.stat(filePath)).size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const base: Record<string, string> = {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  }
  const match = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
  if (match && (match[1] !== '' || match[2] !== '')) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    let end = match[1] && match[2] ? Number(match[2]) : size - 1
    if (!Number.isFinite(start) || start < 0 || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { ...base, 'Content-Range': `bytes */${size}` }
      })
    }
    end = Math.min(end, size - 1)
    if (end < start) end = size - 1
    const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>
    return new Response(body, {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      }
    })
  }
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(body, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
}
