import type { GachaGame, GachaRecord } from '@shared/types'
import { isObject } from '../services/configValidation'
import { sourceRecordId } from './gachaIndex'
import { MIHOYO, topRankFor, type MiHoYoGame } from './metadata'

const NATIVE_FORMAT = 'kevinlauncher-gacha'
const GAMES = ['genshin', 'starrail', 'zzz', 'arknights'] as const
const UID_PATTERN = /^\d+$/
const UPLINK_ID = /^\d{1,19}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const MAX_RECORDS = 500_000
const LOCALES = new Set(['de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr',
  'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw'])
const UIGF_KEYS = { genshin: 'hk4e', starrail: 'hkrpg', zzz: 'nap' } as const
const UIGF_4_0 = { genshin: ['100', '200', '301', '302', '400', '500'], starrail: ['1', '2', '11', '12'], zzz: ['1', '2', '3', '5'] }
const UIGF_LATEST = { ...UIGF_4_0, starrail: [...UIGF_4_0.starrail, '21', '22'] }

function invalid(message: string): never {
  throw new Error(`抽卡文件格式无效：${message}`)
}

function decimal(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof text === 'string' && UID_PATTERN.test(text) ? text : undefined
}

function localTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return undefined
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19).replace('T', ' ') !== value) return undefined
  return date.getTime()
}

export function gachaTimeWithOffset(time: string, timezone?: number): number | undefined {
  const local = localTimestamp(time)
  return local !== undefined && timezone !== undefined ? local - timezone * 3600000 : undefined
}

function offset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= -12 && value <= 14 ? value : undefined
}

function isGame(value: unknown): value is GachaGame {
  return typeof value === 'string' && (GAMES as readonly string[]).includes(value)
}

function rank(value: unknown, game: GachaGame): number {
  if (value === undefined) return 0 // UIGF leaves rarity optional.
  const text = decimal(value)
  if (text === undefined || Number(text) > topRankFor(game)) return invalid('稀有度')
  return Number(text)
}

function claimCapacity(records: GachaRecord[], count: number): void {
  if (records.length + count > MAX_RECORDS) throw new Error(`抽卡文件超过 ${MAX_RECORDS} 条记录上限`)
}

/** Accept v4.0–v4.2 for the three games supported by this launcher. */
function readUigf(
  file: Record<string, unknown>,
  version: string,
  appId: string,
  expectedGame?: GachaGame
): GachaRecord[] {
  if (!['v4.0', 'v4.1', 'v4.2'].includes(version)) return invalid(`不支持的 UIGF 版本 ${version}`)
  if (expectedGame === 'arknights') return invalid('UIGF 不包含明日方舟记录')
  const records: GachaRecord[] = []
  let matched = false
  for (const [game, key] of Object.entries(UIGF_KEYS) as [MiHoYoGame, string][]) {
    if (expectedGame && game !== expectedGame || !Object.hasOwn(file, key)) continue
    matched = true
    const accounts = file[key]
    if (!Array.isArray(accounts)) return invalid(`${key} 不是账号列表`)
    for (const account of accounts) {
      if (!isObject(account) || !Array.isArray(account.list)) return invalid(`${key} 账号结构`)
      const uid = decimal(account.uid)
      const timezone = offset(account.timezone)
      const lang = typeof account.lang === 'string' && LOCALES.has(account.lang) ? account.lang : undefined
      if (!uid || timezone === undefined || (account.lang !== undefined && lang === undefined)) {
        return invalid(`${key} 账号 UID、时区或语言`)
      }
      claimCapacity(records, account.list.length)
      for (const row of account.list) {
        if (!isObject(row) || typeof row.id !== 'string' || !UPLINK_ID.test(row.id) ||
            typeof row.item_id !== 'string' || !row.item_id ||
            typeof row.time !== 'string' || localTimestamp(row.time) === undefined ||
            typeof row.gacha_type !== 'string' ||
            !(version === 'v4.0' ? UIGF_4_0 : UIGF_LATEST)[game].includes(row.gacha_type) ||
            (row.rank_type !== undefined && typeof row.rank_type !== 'string')) return invalid(`${key} 抽卡记录字段`)
        const gachaId = typeof row.gacha_id === 'string' && row.gacha_id ? row.gacha_id : undefined
        if (game === 'starrail' && !gachaId) return invalid(`${key} 记录缺少卡池 ID`)
        const sharedPool = typeof row.uigf_gacha_type === 'string' ? row.uigf_gacha_type : undefined
        if (game === 'genshin' && (!sharedPool || sharedPool !== (row.gacha_type === '400' ? '301' : row.gacha_type))) {
          return invalid(`${key} 卡池保底类型`)
        }
        records.push({
          appId, id: `${game}:${uid}:${row.id}`, game, uid, timezone, lang, time: row.time,
          timestampMs: gachaTimeWithOffset(row.time, timezone), gachaId, uigfGachaType: sharedPool,
          gachaType: row.gacha_type, bannerName: '', itemId: row.item_id,
          itemName: typeof row.name === 'string' ? row.name : '',
          rankType: rank(row.rank_type, game)
        })
      }
    }
  }
  if (!matched) return invalid('文件中没有当前游戏的记录')
  return records
}

function readNative(
  list: unknown[],
  appId: string,
  expectedGame?: GachaGame,
  knownSource = false,
  legacyUid?: string
): GachaRecord[] {
  claimCapacity([], list.length)
  return list.map((row, index) => {
    if (!isObject(row)) return invalid(`第 ${index + 1} 条记录结构`)
    const game = row.game === undefined ? expectedGame : row.game
    const id = row.id ?? row.recordId
    const uid = row.uid === undefined ? legacyUid ?? '' : typeof row.uid === 'string' ? row.uid : decimal(row.uid)
    const time = row.time
    const gachaType = row.gachaType ?? row.gacha_type
    if (!isGame(game) || (expectedGame && game !== expectedGame) || typeof id !== 'string' ||
        !id.trim() || id.length > 512 || uid === undefined || uid.length > 128 ||
        typeof time !== 'string' || (!knownSource && localTimestamp(time) === undefined) ||
        typeof gachaType !== 'string' || !gachaType.trim() ||
        (!knownSource && game !== 'arknights' && !MIHOYO[game].gachaTypes.some(({ type }) => type === gachaType))) {
      return invalid(`第 ${index + 1} 条记录的游戏、UID、ID、时间或卡池`)
    }
    const poolId = row.poolId ?? row.pool_id
    const itemId = row.itemId ?? row.item_id
    const itemName = row.itemName ?? row.name
    const timezone = offset(row.timezone)
    const timestampMs = typeof row.timestampMs === 'number' && Number.isSafeInteger(row.timestampMs) &&
      Number.isFinite(new Date(row.timestampMs).getTime()) ? row.timestampMs : gachaTimeWithOffset(time, timezone)
    return {
      id, appId, game, uid, gachaType, time, timezone, timestampMs,
      poolId: typeof poolId === 'string' ? poolId : undefined,
      bannerName: typeof row.bannerName === 'string' ? row.bannerName : '',
      itemId: typeof itemId === 'string' ? itemId : '',
      itemName: typeof itemName === 'string' ? itemName : '',
      rankType: rank(row.rankType ?? row.rank_type, game),
      seq: decimal(row.seq),
      isUp: typeof row.isUp === 'boolean' ? row.isUp : undefined,
      gachaId: typeof row.gachaId === 'string' ? row.gachaId : undefined,
      uigfGachaType: typeof row.uigfGachaType === 'string' ? row.uigfGachaType : undefined,
      lang: typeof row.lang === 'string' ? row.lang : undefined
    }
  })
}

export function decodeGachaArchive(raw: string, appId: string, expectedGame?: GachaGame): GachaRecord[] {
  let document: unknown
  try {
    document = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return invalid('不是有效的 JSON')
  }
  if (Array.isArray(document)) return readNative(document, appId, expectedGame)
  if (!isObject(document)) return invalid('根对象无效')
  if (document.format === NATIVE_FORMAT) {
    if (document.version !== 1 || !Array.isArray(document.records)) return invalid('KevinLauncher 备份版本')
    return readNative(document.records, appId, expectedGame, true)
  }
  const info = isObject(document.info) ? document.info : undefined
  if (typeof info?.version === 'string' && info.version.startsWith('v4.')) {
    return readUigf(document, info.version, appId, expectedGame)
  }
  // Older KevinLauncher exports used a flat hk4e key for every game.
  if (info?.export_app === 'KevinLauncher' && Array.isArray(document.hk4e)) {
    return readNative(document.hk4e, appId, expectedGame, true)
  }
  if (Array.isArray(document.list)) return readNative(document.list, appId, expectedGame, false, decimal(info?.uid))
  if (Array.isArray(document.records)) return readNative(document.records, appId, expectedGame)
  return invalid('找不到可识别的记录列表')
}

interface UigfAccount {
  uid: string
  timezone: number
  lang?: string
  list: Record<string, string>[]
}

export function exportGachaArchive(records: readonly GachaRecord[], version: string): {
  format: 'uigf' | 'native'
  text: string
} {
  const native = () => ({
    format: 'native' as const,
    text: JSON.stringify({ format: NATIVE_FORMAT, version: 1, records }, null, 2)
  })
  if (!records.length) return native()
  const games: Partial<Record<(typeof UIGF_KEYS)[MiHoYoGame], Map<string, UigfAccount>>> = {}
  for (const record of records) {
    if (record.game === 'arknights') return native()
    const game = record.game
    const id = sourceRecordId(record)
    const timezone = offset(record.timezone)
    if (!UID_PATTERN.test(record.uid) || timezone === undefined || !UPLINK_ID.test(id) || !record.itemId ||
        !UIGF_LATEST[game].includes(record.gachaType) || localTimestamp(record.time) === undefined ||
        (game === 'starrail' && !record.gachaId)) return native()
    const gameAccounts = games[UIGF_KEYS[game]] ??= new Map()
    const account = gameAccounts.get(record.uid) ?? {
      uid: record.uid, timezone, lang: record.lang && LOCALES.has(record.lang) ? record.lang : undefined, list: []
    }
    if (account.timezone !== timezone) return native()
    const row: Record<string, string> = { id, gacha_type: record.gachaType, item_id: record.itemId, time: record.time }
    if (game === 'genshin') row.uigf_gacha_type = record.gachaType === '400' ? '301' : record.gachaType
    if (record.itemName) row.name = record.itemName
    if (record.rankType > 0 && record.rankType <= topRankFor(game)) row.rank_type = String(record.rankType)
    if (record.gachaId) row.gacha_id = record.gachaId
    account.list.push(row)
    gameAccounts.set(record.uid, account)
  }
  const info = {
    export_timestamp: Math.floor(Date.now() / 1000),
    export_app: 'KevinLauncher', export_app_version: version, version: 'v4.2'
  }
  const groups = Object.fromEntries(Object.entries(games).map(([game, accounts]) => [game, [...accounts.values()]]))
  return { format: 'uigf', text: JSON.stringify({ info, ...groups }, null, 2) }
}
