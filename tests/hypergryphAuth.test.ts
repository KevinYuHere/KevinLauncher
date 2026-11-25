import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginHypergryphToken } from '../src/main/gacha/hypergryphAuth'

const mocks = vi.hoisted(() => ({ load: vi.fn(), cookies: vi.fn(), current: null as unknown }))
vi.mock('electron', () => ({
  session: { fromPartition: () => ({ cookies: { get: mocks.cookies } }) },
  BrowserWindow: class extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), { isDestroyed: () => this.destroyed })
    private destroyed = false
    constructor() {
      super()
      mocks.current = this
    }
    setMenuBarVisibility() {}
    loadURL() { return mocks.load() }
    isDestroyed() { return this.destroyed }
    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }
}))

interface WindowFixture {
  webContents: EventEmitter
  close(): void
  isDestroyed(): boolean
}

beforeEach(() => {
  mocks.current = null
  mocks.load.mockResolvedValue(undefined)
  mocks.cookies.mockResolvedValue([{ name: 'fixture', value: 'test' }])
})
afterEach(() => vi.unstubAllGlobals())

describe('鹰角登录', () => {
  it('shares a window and polling request and aborts immediately when the user closes the window', async () => {
    let aborted = false
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    }))
    vi.stubGlobal('fetch', request)
    const first = loginHypergryphToken(null)
    const second = loginHypergryphToken(null)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const window = mocks.current as WindowFixture
    window.webContents.emit('did-navigate')
    window.webContents.emit('did-navigate-in-page')
    expect(request).toHaveBeenCalledOnce()
    window.close()
    await expect(first).rejects.toThrow('登录已取消')
    expect(aborted).toBe(true)
  })

  it('closes the window when navigation fails and lets a later attempt start cleanly', async () => {
    mocks.load.mockRejectedValueOnce(new Error('offline'))
    await expect(loginHypergryphToken(null)).rejects.toThrow('无法打开鹰角登录页')
    expect((mocks.current as WindowFixture).isDestroyed()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(() => Response.json({ status: 0, data: { token: 'fixture-token-only' } })))
    await expect(loginHypergryphToken(null)).resolves.toBe('fixture-token-only')
    expect((mocks.current as WindowFixture).isDestroyed()).toBe(true)
  })
})
