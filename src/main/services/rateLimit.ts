/**
 * Global download rate limit, shared by every download (game pre-download /
 * update and the launcher's own update). `limitBps <= 0` means unlimited.
 *
 * `throttle(bytes)` reserves a time slot on a single schedule, so concurrent
 * downloads together respect the configured ceiling.
 */
import { Transform } from 'stream'
import { MessageChannel, type MessagePort, Worker, workerData } from 'worker_threads'
import { performance } from 'perf_hooks'

let limitBps = 0
let nextAt = 0
let timer: NodeJS.Timeout | null = null

type Request = { bytes: number; release: () => void; signal?: AbortSignal }
const waiting: Request[] = []

function wake(): void {
  if (timer) clearTimeout(timer)
  timer = null
  while (waiting.length) {
    const now = performance.now()
    const request = waiting[0]
    if (!request.signal?.aborted && limitBps > 0 && now < nextAt) {
      timer = setTimeout(wake, Math.min(2 ** 31 - 1, Math.ceil(nextAt - now)))
      return
    }
    waiting.shift()
    if (!request.signal?.aborted && limitBps > 0) {
      nextAt = now + (request.bytes / limitBps) * 1000
    }
    request.release()
  }
}

function requestSlot(bytes: number, signal?: AbortSignal): Promise<void> {
  if (limitBps <= 0 || bytes <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const release = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const request: Request = { bytes, release, signal }
    const onAbort = (): void => {
      const index = waiting.indexOf(request)
      if (index !== -1) waiting.splice(index, 1)
      release()
      wake()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(request)
    if (!timer) wake()
  })
}

/** Configure the limit from the launcher setting (MB/s; 0 = unlimited). */
export function configureRateLimit(megabytesPerSecond: number): void {
  const mbps = Number.isFinite(megabytesPerSecond) ? Math.max(0, megabytesPerSecond) : 0
  limitBps = mbps * 1024 * 1024
  nextAt = 0
  wake()
}

/** Run a download worker against the same bandwidth queue as the main process. */
export function createDownloadWorker(path: string, data?: Record<string, unknown>, ports: MessagePort[] = []): Worker {
  const { port1, port2 } = new MessageChannel()
  const pending = new Map<number, AbortController>()
  let worker: Worker
  try {
    worker = new Worker(path, {
      workerData: { ...data, downloadRatePort: port2 },
      transferList: [port2, ...ports]
    })
  } catch (error) {
    port1.close()
    port2.close()
    throw error
  }
  port1.on('message', ({ id, bytes }: { id: number; bytes?: number }) => {
    if (bytes === undefined) {
      pending.get(id)?.abort()
      return
    }
    const controller = new AbortController()
    pending.set(id, controller)
    void requestSlot(bytes, controller.signal).then(() => {
      pending.delete(id)
      if (!controller.signal.aborted) port1.postMessage(id)
    })
  })
  port1.on('close', () => {
    for (const controller of pending.values()) controller.abort()
    pending.clear()
  })
  worker.once('exit', () => port1.close())
  return worker
}

const mainPort: MessagePort | undefined = workerData?.downloadRatePort
export function closeDownloadWorkerRatePort(): void {
  mainPort?.close()
}
const requests = new Map<number, () => void>()
let requestId = 0
if (mainPort) {
  mainPort.on('message', (id: number) => requests.get(id)?.())
  mainPort.on('close', () => {
    for (const release of requests.values()) release()
  })
}

/** Wait until `bytes` may be transferred under the current limit. */
export async function throttle(bytes: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!mainPort) {
    await requestSlot(bytes, signal)
  } else if (bytes > 0) {
    const port = mainPort
    const id = ++requestId
    await new Promise<void>(resolve => {
      const onAbort = (): void => {
        port.postMessage({ id })
        release()
      }
      const release = (): void => {
        requests.delete(id)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      requests.set(id, release)
      signal?.addEventListener('abort', onAbort, { once: true })
      port.postMessage({ id, bytes })
    })
  }
  signal?.throwIfAborted()
}

/** A pass-through stream that applies the global rate limit. */
export function createThrottleTransform(signal?: AbortSignal): Transform {
  return new Transform({
    async transform(chunk: Buffer, _encoding, callback): Promise<void> {
      try {
        await throttle(chunk.length, signal)
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
