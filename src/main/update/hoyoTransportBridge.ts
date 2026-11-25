import { isMainThread, MessageChannel, type MessagePort, workerData } from 'node:worker_threads'
import type { ReadableStream as TransferableStream } from 'node:stream/web'
import { createDownloadWorker } from '../services/rateLimit'

type Role = 'desktop' | 'runner'
interface NetworkRequest {
  url: string
  method: string
  headers: [string, string][]
  reply: MessagePort
}
interface HeadersReply {
  status: number
  url: string
  headers: [string, string][]
  body: ReadableStream<Uint8Array> | null
}

function chromiumHost(): boolean {
  return isMainThread && process.type === 'browser'
}

async function chromiumFetch(role: Role, url: string | URL, init: RequestInit) {
  const { electronHoYoFetch } = await import('./hoyoTransport')
  return electronHoYoFetch(role, url, init)
}

/** The private channel connects only a launcher-created game worker to its host. */
function serveWorker(port: MessagePort): void {
  const requests = new Set<AbortController>()
  port.on('message', async ({ url, method, headers, reply }: NetworkRequest) => {
    const controller = new AbortController()
    requests.add(controller)
    const abort = () => controller.abort()
    const finish = () => {
      requests.delete(controller)
      reply.close()
    }
    reply.on('message', abort).on('close', abort)
    try {
      const response = await chromiumFetch('runner', url, { method, headers, signal: controller.signal })
      const info = { status: response.status, url: response.url, headers: Array.from(response.headers.entries()) }
      if (!response.body) {
        reply.postMessage({ ...info, body: null })
        finish()
        return
      }
      // Transferring a Web stream propagates read demand and cancellation across
      // the thread boundary. An abandoned reader cannot queue the rest of a game.
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const drain = response.body.pipeTo(writable, { signal: controller.signal })
      void drain.catch(() => undefined).finally(finish)
      reply.postMessage({ ...info, body: readable }, [readable as unknown as TransferableStream<Uint8Array>])
    } catch (error) {
      reply.postMessage({ error: (error as Error).message })
      abort()
      finish()
    }
  })
  port.on('close', () => {
    for (const controller of requests) controller.abort()
  })
}

export function createHoYoDownloadWorker(path: string, data: Record<string, unknown>) {
  if (!chromiumHost()) return createDownloadWorker(path, data)
  const { port1, port2 } = new MessageChannel()
  try {
    const worker = createDownloadWorker(path, { ...data, hoyoNetworkPort: port2 }, [port2])
    serveWorker(port1)
    worker.once('exit', () => port1.close())
    return worker
  } catch (error) {
    port1.close()
    port2.close()
    throw error
  }
}

function fetchFromHost(port: MessagePort, url: string | URL, init: RequestInit): Promise<Response> {
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve, reject) => {
    const abort = () => {
      port1.postMessage('cancel')
      reject(init.signal?.reason)
    }
    port1.once('close', () => {
      init.signal?.removeEventListener('abort', abort)
      reject(new Error('游戏下载连接已关闭'))
    })
    port1.once('message', (reply: HeadersReply | { error: string }) => {
      if ('error' in reply) { reject(new Error(reply.error)); return }
      const response = new Response(reply.body, { status: reply.status, headers: reply.headers })
      Object.defineProperty(response, 'url', { value: reply.url })
      resolve(response)
    })
    try {
      init.signal?.throwIfAborted()
      init.signal?.addEventListener('abort', abort, { once: true })
      port.postMessage({ url: String(url), method: init.method || 'GET', headers: Array.from(new Headers(init.headers).entries()), reply: port2 }, [port2])
    } catch (error) {
      port1.close()
      port2.close()
      reject(error)
    }
  })
}

export function fetchHoYoResource(role: Role, url: string | URL, init: RequestInit): Promise<Response> {
  const hostPort = workerData?.hoyoNetworkPort as MessagePort | undefined
  if (hostPort) return fetchFromHost(hostPort, url, init)
  if (chromiumHost()) return chromiumFetch(role, url, init)
  // Standalone Node tooling and offline tests have no Electron network service.
  return fetch(url, init)
}
