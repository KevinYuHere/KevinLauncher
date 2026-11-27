import { describe, expect, it } from 'vitest'
import {
  displayForPhysicalRect,
  KEVIN_HUD_DEFAULT_WIDTH,
  KEVIN_HUD_MIN_WIDTH,
  measureKevinHudBaseHeight,
  measureKevinHudFrameWidth,
  measureKevinHudPeakHeight,
  measureKevinHudTargetHeight,
  measureKevinHudWidth,
  physicalRectToDip,
  placeKevinHud,
  type KevinHudDisplay,
  type KevinHudPlacementInput,
  type KevinHudWidthConfig
} from '../src/main/services/kevinHudPlacement'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame
} from '../src/shared/kevinHud'
import {
  KEVIN_HUD_ANNOUNCE_STATUS_GAP,
  KEVIN_HUD_ANNOUNCE_STATUS_TEXT,
  measureKevinHudAnnouncementWidth,
  measureKevinHudAnnounceStatusWidth
} from '../src/shared/kevinHudSizing'

const primary: KevinHudDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 }
}

// A 150% display to the left of the primary, with negative DIP and physical origins.
const leftHiDpi: KevinHudDisplay = {
  id: 2,
  bounds: { x: -1280, y: -300, width: 1280, height: 720 },
  workArea: { x: -1280, y: -300, width: 1280, height: 680 },
  scaleFactor: 1.5,
  physicalBounds: { x: -1920, y: -450, width: 1920, height: 1080 }
}

// A 125% display to the right of the primary.
const rightHiDpi: KevinHudDisplay = {
  id: 3,
  bounds: { x: 1920, y: 0, width: 1536, height: 864 },
  workArea: { x: 1920, y: 0, width: 1536, height: 824 },
  scaleFactor: 1.25,
  physicalBounds: { x: 1920, y: 0, width: 1920, height: 1080 }
}

const displays = [primary, leftHiDpi, rightHiDpi]

/**
 * Historical measurement fixture: the 8.5 px icon descriptor and 14 px value
 * of the original 448 x 48 capsule. The fresh production default is the 12 px
 * text descriptor, but these deterministic width fixtures intentionally keep
 * the reference typography so their exact DIP expectations stay meaningful.
 */
const LEGACY_REFERENCE_ITEM_STYLE = {
  ...DEFAULT_KEVIN_HUD.itemStyle,
  description: 'icon' as const,
  descriptionSize: 8.5,
  valueSize: 14
}

function place(overrides: Partial<KevinHudPlacementInput> = {}) {
  return placeKevinHud({
    displays,
    primaryDisplayId: 1,
    monitor: 'primary',
    anchor: 'center',
    x: 50,
    y: 3,
    width: 448,
    height: 48,
    ...overrides
  })
}

function hudFrame(
  overrides: Partial<Omit<KevinHudFrame, 'config'>> & { config?: Partial<KevinHudConfig> } = {}
): KevinHudFrame {
  const { config, ...rest } = overrides
  return {
    phase: 'monitor',
    appName: 'Test App',
    iconUrl: null,
    fontFamily: null,
    appGlass: null,
    values: {},
    ...rest,
    config: { ...DEFAULT_KEVIN_HUD, ...config }
  }
}

function widthConfig(overrides: Partial<KevinHudWidthConfig> = {}): KevinHudWidthConfig {
  return {
    width: 448,
    // Measurement helpers deliberately keep the older broad grow cap so the
    // tests can describe min/max behavior independently of the fixed default.
    maxWidth: 1600,
    autoWidth: true,
    height: DEFAULT_KEVIN_HUD.height,
    borderWidth: 0,
    fontScale: 1,
    itemGap: DEFAULT_KEVIN_HUD.itemGap,
    contentPadding: DEFAULT_KEVIN_HUD.contentPadding,
    // Keep the historical reference typography: these tests pin the exact
    // measured DIPs of the original icon/8.5 px capsule, not the fresh text
    // default (which is asserted from `DEFAULT_KEVIN_HUD` separately).
    itemStyle: LEGACY_REFERENCE_ITEM_STYLE,
    itemStyles: DEFAULT_KEVIN_HUD.itemStyles,
    metrics: [],
    ...overrides
  }
}

describe('physical rect to DIP conversion', () => {
  it('converts using the target display origin and scale factor', () => {
    const dip = physicalRectToDip(
      { x: -1500, y: -400, width: 600, height: 450 },
      leftHiDpi
    )
    expect(dip).not.toBeNull()
    expect(dip!.x).toBeCloseTo(-1000)
    expect(dip!.y).toBeCloseTo(-266.6667, 3)
    expect(dip!.width).toBeCloseTo(400)
    expect(dip!.height).toBeCloseTo(300)
  })

  it('falls back to DIP bounds scaled by the display factor', () => {
    const dip = physicalRectToDip(
      { x: -200, y: -100, width: 100, height: 50 },
      { bounds: { x: -100, y: -50, width: 200, height: 100 }, scaleFactor: 2 }
    )
    expect(dip).toEqual({ x: -100, y: -50, width: 50, height: 25 })
  })

  it('rejects malformed geometry instead of producing NaN bounds', () => {
    expect(
      physicalRectToDip(
        { x: Number.NaN, y: 0, width: 100, height: 100 },
        leftHiDpi
      )
    ).toBeNull()
    expect(physicalRectToDip({ x: 0, y: 0, width: 0, height: 100 }, leftHiDpi)).toBeNull()
  })

  it('selects the display with the largest physical overlap', () => {
    const onLeft = displayForPhysicalRect(displays, {
      x: -1500,
      y: -400,
      width: 600,
      height: 450
    })
    expect(onLeft?.id).toBe(2)

    const onRight = displayForPhysicalRect(displays, {
      x: 2500,
      y: 100,
      width: 300,
      height: 200
    })
    expect(onRight?.id).toBe(3)

    // No overlap still resolves to the nearest display center.
    const offscreen = displayForPhysicalRect(displays, {
      x: 5000,
      y: 3000,
      width: 100,
      height: 100
    })
    expect(offscreen?.id).toBe(3)
  })
})

describe('HUD placement in Electron DIPs', () => {
  it('centers the default HUD in the primary work area', () => {
    expect(place()).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
  })

  it('keeps every configured height at the same custom top', () => {
    expect(place({ height: 48 })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ height: 72 })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 72 },
      displayId: 1
    })
    expect(place({ height: 240 })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 240 },
      displayId: 1
    })
  })

  it('supports negative display origins without wrapping the coordinates', () => {
    const negative: KevinHudDisplay = {
      id: 9,
      bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
      workArea: { x: -1920, y: -200, width: 1920, height: 1040 },
      scaleFactor: 1.5
    }
    const result = place({ displays: [negative], primaryDisplayId: 9 })
    expect(result).toEqual({
      bounds: { x: -1184, y: -169, width: 448, height: 48 },
      displayId: 9
    })
  })

  it('applies the anchor at the x percentage and clamps to the work area', () => {
    expect(place({ anchor: 'left', x: 0 })).toEqual({
      bounds: { x: 0, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ anchor: 'right', x: 0 })).toEqual({
      bounds: { x: 0, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ anchor: 'left', x: 100 })).toEqual({
      bounds: { x: 1472, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ anchor: 'right', x: 100 })).toEqual({
      bounds: { x: 1472, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ y: 100 })).toEqual({
      bounds: { x: 736, y: 992, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ x: -20, y: 300, anchor: 'left' })).toEqual({
      bounds: { x: 0, y: 992, width: 448, height: 48 },
      displayId: 1
    })
  })

  it('fits a HUD larger than the work area instead of clipping it', () => {
    const result = place({ width: 5000, height: 5000 })
    expect(result).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
      displayId: 1
    })
  })

  it('places the game HUD on the selected screen relative to its work area', () => {
    const result = place({
      monitor: 'game',
      displayHint: {
        gameWindowRect: { x: -1500, y: -400, width: 600, height: 450 }
      }
    })
    expect(result).toEqual({
      bounds: { x: -864, y: -280, width: 448, height: 48 },
      displayId: 2
    })
    expect(result!.bounds.x).toBeGreaterThanOrEqual(leftHiDpi.workArea.x)
    expect(result!.bounds.x + result!.bounds.width).toBeLessThanOrEqual(
      leftHiDpi.workArea.x + leftHiDpi.workArea.width
    )
    expect(result!.bounds.y).toBeGreaterThanOrEqual(leftHiDpi.workArea.y)
    expect(result!.bounds.y + result!.bounds.height).toBeLessThanOrEqual(
      leftHiDpi.workArea.y + leftHiDpi.workArea.height
    )
  })

  it('uses the hinted display work area when no game rect is known', () => {
    expect(
      place({
        monitor: 'game',
        displayHint: { displayId: 3 }
      })
    ).toEqual({
      bounds: { x: 2464, y: 25, width: 448, height: 48 },
      displayId: 3
    })
  })

  it('falls back to the primary display for missing or stale game hints', () => {
    expect(place({ monitor: 'game' })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(
      place({
        monitor: 'game',
        displayHint: { displayId: 999 }
      })
    ).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
  })

  it('does not require a hint for the primary monitor', () => {
    expect(place({ monitor: 'primary', displayHint: { displayId: 3 } })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
  })

  it('rejects unusable dimensions and empty display lists', () => {
    expect(place({ width: 0 })).toBeNull()
    expect(place({ height: Number.NaN })).toBeNull()
    expect(place({ displays: [] })).toBeNull()
  })
})

describe('preset top-center placement', () => {
  it('anchors the host 16 physical pixels below the work area at 100%', () => {
    expect(
      place({
        positionMode: 'preset',
        anchor: 'right',
        x: 100,
        y: 100
      })
    ).toEqual({
      bounds: { x: 736, y: 16, width: 448, height: 48 },
      displayId: 1
    })
  })

  it('does not shift the host for taller configured heights', () => {
    // The title grows inside the same-height host, so there is no half-height
    // correction and no 1.5x native title capacity.
    expect(
      place({
        positionMode: 'preset',
        height: 48,
        anchor: 'left',
        x: 0,
        y: 90
      })
    ).toEqual({
      bounds: { x: 736, y: 16, width: 448, height: 48 },
      displayId: 1
    })
    expect(
      place({
        positionMode: 'preset',
        height: 72,
        plateHeight: 48,
        anchor: 'left',
        x: 0,
        y: 90
      })
    ).toEqual({
      bounds: { x: 736, y: 16, width: 448, height: 72 },
      displayId: 1
    })
    expect(
      place({
        positionMode: 'preset',
        height: 240,
        plateHeight: 120
      })
    ).toEqual({
      bounds: { x: 736, y: 16, width: 448, height: 240 },
      displayId: 1
    })
  })

  it('converts the inset through the chosen 150% display scale factor', () => {
    expect(
      place({
        positionMode: 'preset',
        monitor: 'game',
        displayHint: {
          gameWindowRect: { x: -1500, y: -400, width: 600, height: 450 }
        }
      })
    ).toEqual({
      bounds: { x: -864, y: -289, width: 448, height: 48 },
      displayId: 2
    })

    // 16 / 1.5 = 10.67 DIPs. The configured height is not shifted or scaled.
    expect(
      place({
        positionMode: 'preset',
        height: 72,
        monitor: 'game',
        displayHint: { displayId: 2 }
      })
    ).toEqual({
      bounds: { x: -864, y: -289, width: 448, height: 72 },
      displayId: 2
    })
  })

  it('preserves the old percentage placement for custom and omitted modes', () => {
    expect(place({ positionMode: 'custom' })).toEqual({
      bounds: { x: 736, y: 31, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ x: 25, y: 75, anchor: 'left' })).toEqual({
      bounds: { x: 480, y: 780, width: 448, height: 48 },
      displayId: 1
    })
    expect(place({ x: 25, y: 75, anchor: 'left', positionMode: 'custom' })).toEqual(
      place({ x: 25, y: 75, anchor: 'left' })
    )
  })

  it('clamps the preset host to a work area with no room for the title inset', () => {
    const tiny: KevinHudDisplay = {
      id: 7,
      bounds: { x: 0, y: 0, width: 300, height: 100 },
      workArea: { x: 0, y: 0, width: 300, height: 60 },
      scaleFactor: 1.25
    }
    expect(
      placeKevinHud({
        displays: [tiny],
        primaryDisplayId: 7,
        monitor: 'primary',
        anchor: 'center',
        x: 50,
        y: 3,
        width: 448,
        height: 72,
        plateHeight: 48,
        positionMode: 'preset'
      })
    ).toEqual({
      bounds: { x: 0, y: 0, width: 300, height: 60 },
      displayId: 7
    })
  })
})

describe('configured native height', () => {
  it('uses the configured height for announce, monitor and exit', () => {
    for (const height of [24, 48, 60, 120, 240]) {
      for (const phase of ['announce', 'monitor', 'exit'] as const) {
        expect(measureKevinHudTargetHeight({ phase, config: { height } })).toBe(height)
      }
      expect(measureKevinHudBaseHeight({ height })).toBe(height)
      expect(measureKevinHudPeakHeight({ height })).toBe(height)
    }
  })

  it('ignores a previous visible height on exit', () => {
    // A taller starting extent must not keep the old title capacity alive.
    expect(
      measureKevinHudTargetHeight({ phase: 'exit', config: { height: 48 } }, 96)
    ).toBe(48)
    expect(
      measureKevinHudTargetHeight({ phase: 'exit', config: { height: 120 } }, 180)
    ).toBe(120)
  })

  it('falls back safely for malformed configured heights', () => {
    expect(
      measureKevinHudTargetHeight({ phase: 'announce', config: { height: 0 } })
    ).toBe(48)
    expect(
      measureKevinHudTargetHeight({ phase: 'monitor', config: { height: Number.NaN } })
    ).toBe(48)
    expect(
      measureKevinHudTargetHeight({ phase: 'exit', config: { height: Number.NaN } }, 72)
    ).toBe(48)
  })

  it('raises the user height floor for tall vertical item typography', () => {
    const compact = {
      ...DEFAULT_KEVIN_HUD,
      height: 24,
      contentPadding: 0,
      metrics: ['fps' as const]
    }
    expect(measureKevinHudTargetHeight({ phase: 'monitor', config: compact })).toBe(24)
    expect(
      measureKevinHudTargetHeight({
        phase: 'monitor',
        config: {
          ...compact,
          contentPadding: 4,
          itemStyle: {
            ...compact.itemStyle,
            orientation: 'vertical',
            descriptionSize: 24,
            valueSize: 32,
            gap: 24
          }
        }
      })
    ).toBeGreaterThan(24)
  })
})

describe('frame width by phase', () => {
  const longName = 'A'.repeat(40)
  const announce = hudFrame({
    phase: 'announce',
    appName: longName,
    config: {
      width: 1,
      height: 48,
      autoWidth: true,
      // Pin the historical 1 px edge/icon typography so the announcement and
      // settled-width numbers stay the reference measurements. The fresh
      // defaults (gradient, 2 px, text/12) are asserted separately.
      borderWidth: 1,
      itemStyle: LEGACY_REFERENCE_ITEM_STYLE,
      metrics: ['appName', 'fps', 'memory']
    },
    values: { fps: '240 FPS', memory: '31.9/32.0 GB' }
  })

  it('measures an auto-width announcement from its dedicated launch geometry', () => {
    const announcementWidth = measureKevinHudAnnouncementWidth(
      announce.config,
      announce.appName
    )
    expect(measureKevinHudFrameWidth(announce)).toBe(announcementWidth)
    expect(measureKevinHudFrameWidth(announce)).toBe(
      436 + 2 * announce.config.borderWidth
    )
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['appName', 'fps'] }),
        { appName: announce.appName, values: { fps: '240 FPS' } }
      )
    ).toBe(499)
    expect(
      measureKevinHudFrameWidth({
        ...announce,
        values: { fps: '1 FPS', memory: '1/2 GB' }
      })
    ).toBe(measureKevinHudFrameWidth(announce))
    expect(measureKevinHudFrameWidth({ ...announce, appName: '短' })).toBe(
      170 + 2 * announce.config.borderWidth
    )

    // Monitoring item typography must never distort the separate announcement
    // layout: triangle, round icon, app name and launching status stay fixed.
    const restyled = {
      ...announce,
      config: {
        ...announce.config,
        itemGap: 48,
        itemStyle: {
          ...announce.config.itemStyle,
          orientation: 'vertical' as const,
          descriptionSize: 24,
          valueSize: 32,
          gap: 24
        },
        itemStyles: { appName: { gap: 24 } }
      }
    }
    expect(measureKevinHudFrameWidth(restyled)).toBe(announcementWidth)
  })

  it('reserves the launch status in announcements and keeps it out of a monitor frame', () => {
    const monitorWithName = widthConfig({ width: 1, metrics: ['appName'] })
    const monitorWithoutName = widthConfig({ width: 1 })

    // Supplying the identity alone never widens a monitor. Only selecting the
    // `appName` metric adds that item to the settled content width.
    const withoutName = measureKevinHudWidth(monitorWithoutName, {
      appName: longName
    })
    expect(withoutName).toBe(measureKevinHudWidth(monitorWithoutName))
    const withName = measureKevinHudWidth(monitorWithName, { appName: longName })
    expect(withName).toBeGreaterThan(withoutName)

    // The status contributes exactly the measured copy plus its fixed gap on
    // top of the monitor content, independent of the selected metrics.
    const statusReserve =
      measureKevinHudAnnounceStatusWidth(monitorWithName) +
      KEVIN_HUD_ANNOUNCE_STATUS_GAP
    const withStatus = measureKevinHudWidth(monitorWithName, {
      appName: longName,
      announceStatus: KEVIN_HUD_ANNOUNCE_STATUS_TEXT
    })
    expect(withStatus - withName).toBe(statusReserve)

    // A settled monitor frame leaves that status unset. An announcement uses
    // the dedicated launch geometry, which always reserves it.
    const monitorFrameConfig = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      ...monitorWithName
    })
    const monitorFrameWidth = measureKevinHudFrameWidth({
      ...announce,
      phase: 'monitor',
      config: monitorFrameConfig
    })
    expect(monitorFrameWidth).toBe(withName)
    expect(withStatus - monitorFrameWidth).toBe(statusReserve)
    expect(
      measureKevinHudFrameWidth({ ...announce, config: monitorFrameConfig })
    ).toBe(measureKevinHudAnnouncementWidth(monitorFrameConfig, longName))
  })

  it('keeps the untouched fixed reference default at exactly 448 DIPs', () => {
    expect(measureKevinHudWidth(DEFAULT_KEVIN_HUD)).toBe(448)
    expect(measureKevinHudFrameWidth(hudFrame({ phase: 'announce' }))).toBe(448)
    expect(measureKevinHudFrameWidth(hudFrame({ phase: 'monitor' }))).toBe(448)
    expect(
      measureKevinHudFrameWidth(
        hudFrame({ phase: 'announce', appName: 'A'.repeat(400) })
      )
    ).toBe(448)
  })

  it('uses selected metrics for a settled frame and identity for an announcement', () => {
    // A settled monitor renders exactly the selected metrics. An announcement
    // always renders the icon + name identity, independently of that list.
    const settledFps = measureKevinHudFrameWidth({
      ...announce,
      phase: 'monitor',
      config: { ...announce.config, metrics: ['fps'] }
    })
    expect(settledFps).toBe(KEVIN_HUD_MIN_WIDTH)
    expect(
      measureKevinHudFrameWidth({
        ...announce,
        phase: 'monitor',
        config: { ...announce.config, metrics: ['appName'] }
      })
    ).toBe(407 + 2 * announce.config.borderWidth)
    expect(
      measureKevinHudFrameWidth({
        ...announce,
        config: { ...announce.config, metrics: ['fps'] }
      })
    ).toBe(436 + 2 * announce.config.borderWidth)
  })

  it('keeps a taller configured host but does not resize explicit item typography', () => {
    expect(
      measureKevinHudFrameWidth({
        ...announce,
        config: { ...announce.config, height: 72 }
      })
    ).toBe(436 + 2 * announce.config.borderWidth)
  })

  it('retains the visible width for an exit and otherwise measures the frame', () => {
    const frame = hudFrame({ config: { autoWidth: true } })
    expect(measureKevinHudFrameWidth({ ...frame, phase: 'exit' }, 517)).toBe(517)
    expect(measureKevinHudFrameWidth({ ...frame, phase: 'exit' })).toBe(
      measureKevinHudFrameWidth(frame)
    )
    expect(measureKevinHudFrameWidth(frame)).toBe(KEVIN_HUD_DEFAULT_WIDTH)
  })
})

describe('deterministic HUD width', () => {
  const longName = 'A'.repeat(40)

  it('keeps the configured width while autoWidth is off', () => {
    expect(
      measureKevinHudWidth(
        {
          width: 420,
          autoWidth: false,
          fontScale: 1,
          metrics: ['appName', 'fps']
        },
        { appName: 'A very long application name', values: { fps: '240' } }
      )
    ).toBe(420)
    // Existing custom sizes, including the schema minimum and larger values,
    // are preserved instead of being replaced by a content estimate.
    for (const width of [120, 777, 1600]) {
      expect(
        measureKevinHudWidth(
          { width, autoWidth: false, fontScale: 1.25, metrics: ['appName', 'fps'] },
          { appName: 'A very long application name', values: { fps: '240 FPS' } }
        )
      ).toBe(width)
    }
    // A newly supplied explicit cap may grow a formerly fixed HUD, while an
    // absent cap keeps the historical min === max behavior.
    const many = [
      'appName', 'sessionTime', 'totalTime', 'fps', 'gpu',
      'cpu', 'memory', 'download', 'upload', 'clock'
    ] as const
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 420, maxWidth: 900, autoWidth: false, metrics: [...many] }),
        { appName: longName }
      )
    ).toBe(900)
  })

  it('uses the configured width as the auto minimum and grows with content', () => {
    const short = measureKevinHudWidth(
      widthConfig({ metrics: ['appName', 'fps'] }),
      { appName: '原神', values: { fps: '60' } }
    )
    const raisedMinimum = measureKevinHudWidth(
      widthConfig({ width: 1000, metrics: ['appName', 'fps'] }),
      { appName: '原神', values: { fps: '60' } }
    )
    const long = measureKevinHudWidth(
      widthConfig({
        metrics: [
          'appName',
          'sessionTime',
          'totalTime',
          'fps',
          'gpu',
          'cpu',
          'memory',
          'download',
          'upload',
          'clock'
        ]
      }),
      {
        appName: '崩坏：星穹铁道 — 开拓者档案',
        values: {
          sessionTime: '12:34:56',
          totalTime: '1234:56:78',
          fps: '240 FPS',
          gpu: '99%',
          cpu: '100%',
          memory: '31.9/32.0 GB',
          download: '123.4 MB/s',
          upload: '9.8 MB/s',
          clock: '2026-11-25 23:59'
        }
      }
    )
    expect(short).toBe(KEVIN_HUD_DEFAULT_WIDTH)
    expect(raisedMinimum).toBe(1000)
    expect(long).toBe(1189)
    expect(long).toBeGreaterThan(KEVIN_HUD_DEFAULT_WIDTH)
  })

  it('reserves stable metric slots and ignores instantaneous value strings', () => {
    // fps + gpu reserve templates even when both values are unavailable.
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['fps', 'gpu'] })
      )
    ).toBe(181)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['fps', 'gpu'] }),
        { values: { fps: '1'.repeat(40), gpu: '2'.repeat(40) } }
      )
    ).toBe(181)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, borderWidth: 3, metrics: ['fps', 'gpu'] })
      )
    ).toBe(187)
  })

  it('grows the merged identity with the stable title and its real leading icon', () => {
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['appName'] }),
        { appName: 'A'.repeat(40) }
      )
    ).toBe(407)
    // Duplicate ids collapse before measuring; appIcon is no longer a canonical
    // metric and production configs arrive already normalized.
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['appName', 'appName'] }),
        { appName: 'A'.repeat(40) }
      )
    ).toBe(407)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, height: 72, metrics: ['appName', 'fps'] }),
        { appName: 'A'.repeat(40), values: { fps: '1'.repeat(40) } }
      )
    ).toBe(499)
  })

  it('respects a user-adjusted auto minimum above the reference default', () => {
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 620, metrics: ['appName'] }),
        { appName: '原神' }
      )
    ).toBe(620)
    // The identity slot is deliberately bounded, so a very long name alone
    // still stays at the user's minimum; adding real value items grows it.
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 620, metrics: ['appName'] }),
        { appName: 'A'.repeat(120) }
      )
    ).toBe(620)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 620, metrics: ['appName', 'fps', 'gpu', 'memory'] }),
        { appName: 'A'.repeat(120) }
      )
    ).toBeGreaterThan(620)
  })

  it('ignores duplicate and unknown metrics', () => {
    const base = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['fps', 'gpu'] })
    )
    const duplicate = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['fps', 'fps', 'gpu'] })
    )
    const unknown = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['fps', 'gpu', 'not-a-metric' as never] })
    )
    expect(duplicate).toBe(base)
    expect(unknown).toBe(base)
  })

  it('reserves unavailable metric cells and their placeholders', () => {
    const unavailable = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['fps', 'gpu'] }),
      { values: { fps: '1'.repeat(40), gpu: null } }
    )
    const withoutUnavailable = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['fps'] }),
      { values: { fps: '1'.repeat(40) } }
    )
    expect(unavailable).toBeGreaterThan(withoutUnavailable)
  })

  it('accounts for CJK width and font scale', () => {
    const ascii = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['appName'] }),
      { appName: 'a'.repeat(20) }
    )
    const cjk = measureKevinHudWidth(
      widthConfig({ width: 1, metrics: ['appName'] }),
      { appName: '星'.repeat(20) }
    )
    const scaled = measureKevinHudWidth(
      widthConfig({ width: 1, fontScale: 1.25, metrics: ['appName'] }),
      { appName: '星'.repeat(20) }
    )
    const asciiScaled = measureKevinHudWidth(
      widthConfig({ width: 1, fontScale: 1.25, metrics: ['appName'] }),
      { appName: 'A'.repeat(30) }
    )
    expect(cjk).toBeGreaterThan(ascii)
    expect(scaled).toBeGreaterThan(cjk)
    expect(asciiScaled).toBe(385)
  })

  it('keeps the identity fallback inside the usable minimum width', () => {
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 448, metrics: [] }),
        {}
      )
    ).toBe(KEVIN_HUD_DEFAULT_WIDTH)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: ['appName'] }),
        {}
      )
    ).toBe(KEVIN_HUD_MIN_WIDTH)
    expect(
      measureKevinHudWidth(
        widthConfig({ width: 1, metrics: [] }),
        {}
      )
    ).toBe(KEVIN_HUD_MIN_WIDTH)
  })
})
