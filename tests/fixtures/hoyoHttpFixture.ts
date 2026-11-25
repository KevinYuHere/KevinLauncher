import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

interface FixtureResponse {
  body?: Buffer | string
  status?: number
  range?: 'honor' | 'ignore' | 'wrong-start'
  /** Send part of the body, then terminate the socket or wait for cancellation. */
  interrupt?: { after: number; mode: 'disconnect' | 'wait'; delayMs?: number }
}

export interface FixtureRequest {
  method: string
  path: string
  range: string | null
}

/** Loopback CDN with scripted status, range and stream failures. */
export async function startHoyoHttpFixture() {
  const requests: FixtureRequest[] = []
  const routes = new Map<string, { responses: FixtureResponse[]; calls: number }>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const range = request.headers.range ?? null
    requests.push({ method: request.method ?? 'GET', path, range })

    const route = routes.get(path)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    const reply = route.responses[Math.min(route.calls++, route.responses.length - 1)]
    const full = Buffer.from(reply.body ?? '')
    let body = full
    let status = reply.status ?? 200
    if (range && status === 200 && reply.range !== 'ignore') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      const start = match ? Number(match[1]) : full.length
      const end = match?.[2] ? Number(match[2]) : full.length - 1
      if (start >= full.length || end >= full.length || start > end) {
        response.writeHead(416, { 'content-range': `bytes */${full.length}` }).end()
        return
      }
      const reportedStart = start + (reply.range === 'wrong-start' ? 1 : 0)
      response.setHeader('content-range', `bytes ${reportedStart}-${end}/${full.length}`)
      status = 206
      body = full.subarray(start, end + 1)
    }
    response.writeHead(status, { 'content-length': body.length })
    if (reply.interrupt) {
      const { after, mode, delayMs } = reply.interrupt
      response.write(body.subarray(0, after), () => {
        if (mode === 'disconnect') setTimeout(() => response.destroy(), delayMs ?? 25)
      })
    } else {
      response.end(body)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    route(path: string, first: FixtureResponse, ...rest: FixtureResponse[]): void {
      routes.set(path, { calls: 0, responses: [first, ...rest] })
    },
    close(): Promise<void> {
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
