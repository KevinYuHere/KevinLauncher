import { describe, expect, it } from 'vitest'
import {
  LAUNCHER_FONT_CJK_FAMILY,
  LAUNCHER_FONT_CJK_RANGE,
  LAUNCHER_FONT_LATIN_FAMILY,
  LAUNCHER_FONT_LATIN_RANGE,
  launcherFontFaceCss,
  launcherFontStack,
  resolveLauncherFonts
} from '../src/shared/launcherFonts'
import { normalizeLauncherConfig } from '../src/main/services/configValidation'
import { CURRENT_VERSION } from '../src/main/services/appMigrations'

describe('launcher font resolution', () => {
  it('maps a legacy single font to both script selections', () => {
    expect(resolveLauncherFonts({ fontFamily: 'Legacy Sans' })).toEqual({
      en: 'Legacy Sans',
      zh: 'Legacy Sans'
    })
  })

  it('keeps independent English and Chinese choices even with a legacy value present', () => {
    expect(resolveLauncherFonts({
      fontFamily: 'Legacy Sans',
      fontFamilyEn: 'English Sans',
      fontFamilyZh: 'Chinese Sans'
    })).toEqual({ en: 'English Sans', zh: 'Chinese Sans' })
  })

  it('falls back per missing script and treats explicit null as a separate reset', () => {
    expect(resolveLauncherFonts({
      fontFamily: 'Legacy Sans',
      fontFamilyEn: 'English Sans'
    })).toEqual({ en: 'English Sans', zh: 'Legacy Sans' })
    expect(resolveLauncherFonts({
      fontFamily: 'Legacy Sans',
      fontFamilyZh: 'Chinese Sans'
    })).toEqual({ en: 'Legacy Sans', zh: 'Chinese Sans' })
    expect(resolveLauncherFonts({
      fontFamily: 'Legacy Sans',
      fontFamilyEn: null,
      fontFamilyZh: null
    })).toEqual({ en: null, zh: null })
  })

  it('materializes a legacy backup into both persistent fields on config normalize', () => {
    const config = normalizeLauncherConfig({
      version: CURRENT_VERSION,
      apps: [],
      launcher: { fontFamily: 'Legacy Sans' }
    })
    expect(config.launcher).toMatchObject({
      fontFamily: 'Legacy Sans',
      fontFamilyEn: 'Legacy Sans',
      fontFamilyZh: 'Legacy Sans'
    })
  })

  it('assigns the two selected fonts to disjoint script ranges', () => {
    const fonts = { en: 'English Sans', zh: 'Chinese Sans' }
    const css = launcherFontFaceCss(fonts)

    expect(css).toContain(`font-family: "${LAUNCHER_FONT_LATIN_FAMILY}"`)
    expect(css).toContain('local("English Sans")')
    expect(css).toContain(`unicode-range: ${LAUNCHER_FONT_LATIN_RANGE}`)
    expect(css).toContain(`font-family: "${LAUNCHER_FONT_CJK_FAMILY}"`)
    expect(css).toContain('local("Chinese Sans")')
    expect(css).toContain(`unicode-range: ${LAUNCHER_FONT_CJK_RANGE}`)
    expect(launcherFontStack(fonts)).toContain(`"${LAUNCHER_FONT_LATIN_FAMILY}"`)
    expect(launcherFontStack(fonts)).toContain(`"${LAUNCHER_FONT_CJK_FAMILY}"`)
  })
})
