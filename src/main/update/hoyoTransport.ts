import { Readable } from 'node:stream'
import type { Session } from 'electron'
import { log } from '../services/logger'

type Role = 'desktop' | 'runner'
type Slot = { session: Session; active: number; closing?: Promise<void> }
type ElectronNetwork = Pick<typeof import('electron'), 'session' | 'net'>
const MINUTE = 60_000

class HoyoConnectionPool {
  private readonly slots: Slot[] = []
  private current?: Slot
  private expiresAt = 0

  constructor(
    private readonly role: Role, private readonly lifetime: number,
    private readonly fromPartition: ElectronNetwork['session']['fromPartition']
  ) {}

  acquire(): Slot {
    const now = performance.now()
    if (!this.current || now >= this.expiresAt) {
      if (this.current?.active === 0) {
        this.close(this.current)
      } else {
        this.current = this.slots.find(slot => slot.active === 0)
        if (!this.current) {
          const partition = `kevin-hoyo-${this.role}-${this.slots.length}`
          this.current = { session: this.fromPartition(partition, { cache: false }), active: 0 }
          this.slots.push(this.current)
        }
      }
      this.expiresAt = now + this.lifetime
    }
    this.current.active++
    return this.current
  }

  release(slot: Slot): void {
    slot.active--
    if (slot.active === 0 && slot !== this.current) this.close(slot)
  }

  private close(slot: Slot): void {
    if (slot.closing) return
    // Retire sockets without deleting the partition's learned Alt-Svc entries.
    slot.closing = slot.session.closeAllConnections().catch(error => {
      log('[hoyo] unable to close expired connections', error)
    }).finally(() => { slot.closing = undefined })
  }
}

async function waitForClosing(closing: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
  if (!closing) return
  signal.throwIfAborted()
  const abort = Promise.withResolvers<never>()
  const cancel = () => abort.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await Promise.race([closing, abort.promise])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

function responseHeaders(headers: Record<string, string | string[]>): Headers {
  const result = new Headers()
  for (const [name, raw] of Object.entries(headers)) {
    for (const value of typeof raw === 'string' ? [raw] : raw) {
      result.append(name, /[^\x00-\xff]/.test(value) ? Buffer.from(value).toString('latin1') : value)
    }
  }
  return result
}

function makeResponse(body: ReadableStream | null, init: ResponseInit, url: string, redirected: boolean): Response {
  // Electron's Session.fetch drops this metadata. Use Chromium's redirect
  // event so the CDN port policy sees the response's actual destination.
  return Object.defineProperties(new Response(body, init), {
    url: { value: url },
    redirected: { value: redirected }
  })
}

function requestHoyo(
  net: ElectronNetwork['net'], session: Session, value: Request, body: Buffer | undefined, release: () => void
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { signal } = value
    const request = net.request({
      session, url: value.url, method: value.method, headers: Object.fromEntries(value.headers),
      credentials: 'omit', redirect: value.redirect, bypassCustomProtocolHandlers: true
    })
    let incoming: Readable | undefined
    let finalUrl = value.url
    let redirected = false
    let cancelled = false

    function cancelRequest(): void {
      if (cancelled) return
      cancelled = true
      request.abort()
    }

    function done(): void {
      signal.removeEventListener('abort', abort)
      release()
    }
    function abort(): void {
      const reason = signal.reason
      incoming?.destroy(reason instanceof Error ? reason : new Error(String(reason)))
      cancelRequest()
      done()
      reject(reason)
    }

    signal.addEventListener('abort', abort, { once: true })
    request.on('error', error => {
      done()
      reject(error)
    })
    request.on('redirect', (status, _method, url, headers) => {
      if (value.redirect === 'manual') {
        try {
          resolve(makeResponse(null, { headers: responseHeaders(headers), status }, finalUrl, false))
        } catch (error) {
          reject(error)
        }
        cancelRequest()
        done()
        return
      }
      redirected = true
      finalUrl = url
    })
    request.once('response', response => {
      // The public Electron types expose only the events, though the actual
      // IncomingMessage is a Node Readable and supports backpressure.
      const source = response as unknown as Readable
      incoming = source
      source.on('error', reject)
      source.once('end', done)
      source.once('close', () => {
        if (!source.readableEnded) cancelRequest()
        done()
      })
      try {
        const { statusCode: status, statusMessage: statusText } = response
        const headers = responseHeaders(response.headers)
        const hasBody = value.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304
        const stream = hasBody
          ? Readable.toWeb(source, { strategy: { highWaterMark: 1 } }) as unknown as ReadableStream
          : null
        resolve(makeResponse(stream, { status, statusText, headers }, finalUrl, redirected))
        if (!hasBody) source.resume()
      } catch (error) {
        cancelRequest()
        done()
        reject(error)
      }
    })
    try {
      request.end(body)
    } catch (error) {
      cancelRequest()
      done()
      reject(error)
    }
  })
}

export function createElectronHoYoFetch(electron: () => ElectronNetwork) {
  const fromPartition: ElectronNetwork['session']['fromPartition'] = (name, options) =>
    electron().session.fromPartition(name, options)
  const pools = {
    desktop: new HoyoConnectionPool('desktop', 10 * MINUTE, fromPartition),
    runner: new HoyoConnectionPool('runner', 2 * MINUTE, fromPartition)
  }
  return async (role: Role, url: string | URL, init?: RequestInit): Promise<Response> => {
    const value = new Request(String(url), init)
    if (!['http:', 'https:'].includes(new URL(value.url).protocol)) {
      throw new TypeError('HoYoPlay 请求必须使用 HTTP 或 HTTPS')
    }
    value.signal.throwIfAborted()
    const body = value.body ? Buffer.from(await value.arrayBuffer()) : undefined
    const pool = pools[role]
    const slot = pool.acquire()
    let released = false
    const release = () => {
      if (released) return
      released = true
      pool.release(slot)
    }
    try {
      await waitForClosing(slot.closing, value.signal)
      value.signal.throwIfAborted()
      return await requestHoyo(electron().net, slot.session, value, body, release)
    } catch (error) {
      release()
      throw error
    }
  }
}

// The Electron APIs are only present in the main process, even when this
// module is bundled with other transport code for headless workers.
export const electronHoYoFetch = createElectronHoYoFetch(() => require('electron') as ElectronNetwork)
