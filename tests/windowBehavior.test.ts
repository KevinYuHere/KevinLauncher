import { describe, expect, it, vi } from 'vitest'
import { setMainWindowProvider, showMainWindow } from '../src/main/services/behavior'
import type { BrowserWindow } from 'electron'

const viewer = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [viewer] } }))

describe('main window identity', () => {
  it('recreates and shows the main window with a gallery viewer still open', () => {
    const primary = {
      isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(),
      focus: vi.fn(), show: vi.fn(), webContents: { send: vi.fn() }
    }
    const recreate = vi.fn(() => primary as unknown as BrowserWindow)
    setMainWindowProvider(recreate)
    showMainWindow()
    expect(recreate).toHaveBeenCalledOnce()
    expect(primary.restore).toHaveBeenCalledOnce()
    expect(primary.focus).toHaveBeenCalledOnce()
    expect(primary.show).toHaveBeenCalledOnce()
    expect(viewer.show).not.toHaveBeenCalled()
  })
})
