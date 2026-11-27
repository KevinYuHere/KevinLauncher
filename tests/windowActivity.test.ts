import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { observeWindowActivity } from '../src/main/services/windowActivity'

const powerMonitor = vi.hoisted(() => {
  const listeners = new Map<string, () => void>()
  return {
    on: (event: string, listener: () => void) => { listeners.set(event, listener) },
    off: (event: string) => { listeners.delete(event) },
    getSystemIdleState: () => 'active',
    emit: (event: string) => { listeners.get(event)?.() }
  }
})

vi.mock('electron', () => ({ powerMonitor }))

class FakeWindow extends EventEmitter {
  readonly webContents = { send: vi.fn(), isDestroyed: () => false }
  readonly isDestroyed = () => false
}

describe('window foreground activity', () => {
  it('reports the launcher foreground only while visible, focused and the system is awake', () => {
    const window = new FakeWindow()
    const changes: boolean[] = []
    observeWindowActivity(
      window as unknown as BrowserWindow,
      false,
      (foreground) => changes.push(foreground)
    )
    expect(changes).toEqual([false])

    window.emit('show')
    expect(changes).toEqual([false])
    window.emit('focus')
    expect(changes).toEqual([false, true])
    window.emit('blur')
    expect(changes.at(-1)).toBe(false)

    window.emit('focus')
    powerMonitor.emit('lock-screen')
    expect(changes.at(-1)).toBe(false)
    powerMonitor.emit('unlock-screen')
    expect(changes.at(-1)).toBe(true)

    window.emit('minimize')
    expect(changes.at(-1)).toBe(false)
    window.emit('restore')
    expect(changes.at(-1)).toBe(false)
    window.emit('focus')
    expect(changes.at(-1)).toBe(true)

    powerMonitor.emit('suspend')
    expect(changes.at(-1)).toBe(false)
    powerMonitor.emit('resume')
    expect(changes.at(-1)).toBe(true)

    window.emit('hide')
    expect(changes.at(-1)).toBe(false)
    window.emit('show')
    expect(changes.at(-1)).toBe(false)
    window.emit('focus')
    expect(changes.at(-1)).toBe(true)
  })
})
