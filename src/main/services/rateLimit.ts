/**
 * Global download rate limit, shared by every download (game pre-download /
 * update and the launcher's own update). `limitBps <= 0` means unlimited.
 *
 * `throttle(bytes)` reserves a time slot on a single schedule, so concurrent
 * downloads together respect the configured ceiling.
 */
import { Transform } from 'stream'

let limitBps = 0
let nextAt = 0

/** Configure the limit from the launcher setting (MB/s; 0 = unlimited). */
export function configureRateLimit(megabytesPerSecond: number): void {
  const mbps = Number.isFinite(megabytesPerSecond) ? Math.max(0, megabytesPerSecond) : 0
  limitBps = mbps * 1024 * 1024
  nextAt = 0
}

export function rateLimitBytesPerSecond(): number {
  return limitBps
}

/** Wait until `bytes` may be transferred under the current limit. */
export async function throttle(bytes: number): Promise<void> {
  if (limitBps <= 0 || bytes <= 0) return
  const now = Date.now()
  const start = Math.max(now, nextAt)
  nextAt = start + (bytes / limitBps) * 1000
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now))
}

/** A pass-through stream that applies the global rate limit. */
export function createThrottleTransform(): Transform {
  return new Transform({
    async transform(chunk: Buffer, _encoding, callback): Promise<void> {
      try {
        await throttle(chunk.length)
        callback(null, chunk)
      } catch (error) {
        callback(error as Error)
      }
    }
  })
}

/** Read a fetch body fully while applying the rate limit. */
export async function readBodyThrottled(response: Response): Promise<Buffer> {
  const body = response.body
  if (!body) return Buffer.from(await response.arrayBuffer())
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.length) {
      await throttle(value.length)
      parts.push(value)
    }
  }
  return Buffer.concat(parts)
}
