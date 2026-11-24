import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { createElectronHoYoFetch } from '../src/main/update/hoyoTransport'

const electron = { request: vi.fn(), fromPartition: vi.fn() }

class ChromiumRequest extends EventEmitter {
  readonly response = Object.assign(new PassThrough(), {
    statusCode: 200, statusMessage: 'OK', headers: { 'x-server': 'chromium-fixture' }
  })
  readonly end = vi.fn()
  readonly abort = vi.fn(() => { this.response.destroy() })
}

type Fetch = typeof import('../src/main/update/hoyoTransport').electronHoYoFetch
const requestUrl = 'https://127.0.0.1:443/files'
const redirectUrl = 'https://127.0.0.1:8443/redirected'
const minute = 60_000
let fetchHoYo: Fetch
let elapsed: number
const requests: ChromiumRequest[] = []
const sessions = new Map<string, { closeAllConnections: ReturnType<typeof vi.fn> }>()

beforeEach(() => {
  vi.restoreAllMocks()
  requests.length = 0
  sessions.clear()
  elapsed = 0
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  electron.request.mockReset().mockImplementation(() => {
    const request = new ChromiumRequest()
    requests.push(request)
    return request
  })
  electron.fromPartition.mockReset().mockImplementation((name: string) => {
    expect(sessions.has(name)).toBe(false)
    const session = { closeAllConnections: vi.fn(async () => {}) }
    sessions.set(name, session)
    return session
  })
  fetchHoYo = createElectronHoYoFetch(() => ({
    net: { request: electron.request }, session: { fromPartition: electron.fromPartition }
  }) as unknown as ReturnType<Parameters<typeof createElectronHoYoFetch>[0]>)
})

async function start(role: Parameters<Fetch>[0], init?: RequestInit) {
  const index = requests.length
  const response = fetchHoYo(role, requestUrl, init)
  await vi.waitFor(() => expect(requests).toHaveLength(index + 1))
  return { request: requests[index], response, native: electron.request.mock.calls[index][0] }
}

it('reuses an idle partition and closes its connections on each role’s deadline', async () => {
  for (const role of ['desktop', 'runner'] as const) {
    const { request, response } = await start(role)
    request.emit('response', request.response)
    request.response.end('ready')
    expect(await (await response).text()).toBe('ready')
  }
  const desktop = sessions.get('kevin-hoyo-desktop-0')!
  const runner = sessions.get('kevin-hoyo-runner-0')!
  expect(electron.fromPartition.mock.calls).toEqual([
    ['kevin-hoyo-desktop-0', { cache: false }], ['kevin-hoyo-runner-0', { cache: false }]
  ])

  elapsed = 2 * minute
  const afterTwo = await start('runner')
  const desktopFirst = await start('desktop')
  expect(afterTwo.native.session).toBe(runner)
  expect(desktopFirst.native.session).toBe(desktop)
  expect(runner.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(desktop.closeAllConnections).not.toHaveBeenCalled()
  const abort = new Error('request failed at headers')
  for (const { request, response } of [afterTwo, desktopFirst]) {
    request.emit('error', abort)
    await expect(response).rejects.toBe(abort)
  }

  elapsed = 10 * minute
  const afterTen = await start('desktop')
  expect(afterTen.native.session).toBe(desktop)
  expect(desktop.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(sessions.size).toBe(2)
  afterTen.request.emit('error', abort)
  await expect(afterTen.response).rejects.toBe(abort)
})

it('rotates while two generations are streaming and reuses an idle earlier session', async () => {
  const first = await start('runner')
  first.request.emit('response', first.request.response)
  first.request.response.write('prefix:')
  const firstReader = (await first.response).body!.getReader()
  expect(Buffer.from((await firstReader.read()).value!).toString()).toBe('prefix:')

  elapsed = 2 * minute
  const second = await start('runner')
  expect(second.native.session).not.toBe(first.native.session)
  second.request.emit('response', second.request.response)
  const secondBody = (await second.response).body!

  elapsed = 4 * minute
  const third = await start('runner')
  expect(sessions.size).toBe(3)
  expect(first.native.session.closeAllConnections).not.toHaveBeenCalled()
  expect(second.native.session.closeAllConnections).not.toHaveBeenCalled()

  first.request.response.end('suffix')
  expect(Buffer.from((await firstReader.read()).value!).toString()).toBe('suffix')
  expect((await firstReader.read()).done).toBe(true)
  await secondBody.cancel()
  await vi.waitFor(() => {
    expect(first.native.session.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(second.native.session.closeAllConnections).toHaveBeenCalledTimes(1)
  })
  expect(first.request.abort).not.toHaveBeenCalled()
  expect(second.request.abort).toHaveBeenCalledTimes(1)

  elapsed = 6 * minute
  const fourth = await start('runner')
  expect(fourth.native.session).toBe(first.native.session)
  expect(sessions.size).toBe(3)
  const error = new Error('request stopped before headers')
  for (const { request, response } of [third, fourth]) {
    request.emit('error', error)
    await expect(response).rejects.toBe(error)
  }
})

it('retains headers and final redirect URL and aborts an active response body', async () => {
  const abort = new AbortController()
  const { native, request, response } = await start('desktop', {
    headers: { Range: 'bytes=10-20', 'User-Agent': 'KevinLauncher/2.0.5' }, signal: abort.signal
  })
  expect(native).toMatchObject({
    headers: { range: 'bytes=10-20', 'user-agent': 'KevinLauncher/2.0.5' },
    credentials: 'omit', bypassCustomProtocolHandlers: true
  })
  request.emit('redirect', 302, 'GET', redirectUrl, { location: [redirectUrl] })
  request.emit('response', request.response)
  const delivered = await response
  expect(delivered.url).toBe(redirectUrl)
  expect(delivered.redirected).toBe(true)
  expect(delivered.headers.get('x-server')).toBe('chromium-fixture')
  const reader = delivered.body!.getReader()
  const error = new Error('cancel requested')
  abort.abort(error)
  await expect(reader.read()).rejects.toBe(error)
  expect(request.abort).toHaveBeenCalled()
})

it('honors cancellation while waiting for the connection pool to close', async () => {
  const first = await start('runner')
  first.request.emit('response', first.request.response)
  first.request.response.end('ready')
  await (await first.response).text()

  const closing = Promise.withResolvers<void>()
  first.native.session.closeAllConnections.mockReturnValueOnce(closing.promise)
  elapsed = 2 * minute
  const abort = new AbortController()
  const error = new Error('cancel during rotation')
  const pending = fetchHoYo('runner', requestUrl, { signal: abort.signal })
  abort.abort(error)
  await expect(pending).rejects.toBe(error)
  expect(requests).toHaveLength(1)
  closing.resolve()
  const { native, request, response } = await start('runner')
  expect(native.session).toBe(first.native.session)
  request.emit('response', request.response)
  request.response.end('resumed')
  expect(await (await response).text()).toBe('resumed')
})
