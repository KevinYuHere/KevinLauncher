import { describe, expect, it } from 'vitest'
import { resolveHudLiveDispatch } from '../src/renderer/src/components/KevinHudSettings'

/**
 * Regression guard: the editor must keep amending an already running HUD even
 * when the user never opened the preview. Only the legacy fallback (onPreview)
 * requires preview ownership.
 */
describe('KEVIN HUD live editor without an open preview', () => {
  it('sends, waits and skips for a validated live channel', () => {
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        liveActive: true,
        inFlight: false,
        signature: 'latest',
        appliedSignature: ''
      })
    ).toBe('send')
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        liveActive: true,
        inFlight: true,
        signature: 'latest',
        appliedSignature: 'older'
      })
    ).toBe('wait')
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        liveActive: true,
        inFlight: false,
        signature: 'same',
        appliedSignature: 'same'
      })
    ).toBe('skip')
  })

  it('keeps the preview-only callers closed until a preview is open', () => {
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        inFlight: false,
        signature: 'latest',
        appliedSignature: ''
      })
    ).toBe('skip')
  })
})
