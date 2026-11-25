import { describe, expect, it } from 'vitest'
import { decodeGachaArchive, exportGachaArchive } from '../src/main/gacha/gachaFormats'
import { GachaIndex } from '../src/main/gacha/gachaIndex'

const base = { id: '1123456789123456789', item_id: '10000001', time: '2026-01-08 08:05:00', name: '测试角色', rank_type: '5' }
const data = {
  info: { version: 'v4.2', export_timestamp: 1767879000, export_app: 'fixture', export_app_version: '1.0.0' },
  hk4e: [
    { uid: '1000', timezone: 8, lang: 'zh-cn', list: [{ ...base, gacha_type: '400', uigf_gacha_type: '301' }] },
    { uid: 2000, timezone: -5, list: [{ ...base, gacha_type: '301', uigf_gacha_type: '301' }] }
  ],
  hkrpg: [{ uid: '3000', timezone: 8, list: [{ ...base, gacha_type: '21', gacha_id: '1041' }] }],
  nap: [{ uid: '4000', timezone: 8, list: [{ ...base, gacha_type: '2', rank_type: '4' }] }]
}

describe('抽卡格式适配', () => {
  it('round-trips v4.2 accounts, timezones, pull IDs and pity-group types for the three supported games', () => {
    const records = decodeGachaArchive(JSON.stringify(data), 'test')
    expect(records.map(({ uid }) => uid)).toEqual(['1000', '2000', '3000', '4000'])
    expect(records[0].timestampMs).toBe(Date.parse('2026-01-08T00:05:00Z'))
    expect(records[1].timestampMs).toBe(Date.parse('2026-01-08T13:05:00Z'))
    const archive = exportGachaArchive(records, '2.0.5')
    expect(archive.format).toBe('uigf')
    const file = JSON.parse(archive.text)
    expect(file.info.version).toBe('v4.2')
    expect(file.hk4e[0].list[0]).toMatchObject({ id: base.id, uigf_gacha_type: '301', gacha_type: '400' })
    expect(file.hkrpg[0].list[0].gacha_id).toBe('1041')
    expect(decodeGachaArchive(archive.text, 'test')).toEqual(records)
    expect(decodeGachaArchive(archive.text, 'target', 'zzz')).toHaveLength(1)
  })

  it('supports v4.0 and v4.1 without accepting a future layout or a banner outside the declared version', () => {
    for (const version of ['v4.0', 'v4.1']) {
      const fixture = { ...data, info: { ...data.info, version } }
      expect(decodeGachaArchive(JSON.stringify(fixture), 'test', 'genshin')).toHaveLength(2)
      if (version === 'v4.0') expect(() => decodeGachaArchive(JSON.stringify(fixture), 'test', 'starrail')).toThrow()
      else expect(decodeGachaArchive(JSON.stringify(fixture), 'test', 'starrail')).toHaveLength(1)
    }
    const future = { ...data, info: { ...data.info, version: 'v4.9' } }
    expect(() => decodeGachaArchive(JSON.stringify(future), 'test')).toThrow('不支持的 UIGF 版本')
  })

  it.each([
    { time: '2026-02-31 08:05:00' }, { id: 1123456789123456790 },
    { rank_type: '9' }, { gacha_type: 'unknown' }
  ])('rejects a malformed official row (%j)', (patch) => {
    const account = data.hk4e[0]
    const bad = { ...data, hk4e: [{ ...account, list: [{ ...account.list[0], ...patch }] }] }
    expect(() => decodeGachaArchive(JSON.stringify(bad), 'test', 'genshin')).toThrow()
  })

  it('retains an older native record without inventing its missing UID or order', () => {
    const legacy = { info: { export_app: 'KevinLauncher', uigf_version: 'v4.0' }, hk4e: [
      { id: 'prior-char-id', game: 'arknights', gachaType: 'normal', rankType: 4, time: '2026-01-01 00:00:00' }
    ] }
    const records = decodeGachaArchive(JSON.stringify(legacy), 'test', 'arknights')
    expect(records[0]).toMatchObject({ uid: '', id: 'prior-char-id', seq: undefined })
    expect(new GachaIndex(records).stats('arknights').pools[0].pityKnown).toBe(false)
    expect(exportGachaArchive(records, '2.0.5').format).toBe('native')
  })
})
