import type { GachaRecord } from '@shared/types'
import { isObject } from '../services/configValidation'
import { HYPERGRYPH } from './metadata'

type CookieJar = Map<string, Map<string, string>>
const REQUEST_TIMEOUT = 20_000
const PAGE_SIZE = 10
const PAGE_LIMIT = 2000

export class ArknightsAuthError extends Error {}

function failed(step: string, detail: string, authentication: boolean): Error {
  const message = `明日方舟·${step}失败（${detail}）`
  return authentication ? new ArknightsAuthError(message) : new Error(message)
}

async function request(
  jar: CookieJar,
  url: string | URL,
  step: string,
  signal: AbortSignal,
  init: RequestInit = {},
  authentication = false
): Promise<unknown> {
  const host = new URL(url).host
  const cookies = jar.get(host) ?? new Map<string, string>()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
  let response: Response
  try {
    response = await fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) })
  } catch {
    throw failed(step, '连接失败或超时', false)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw failed(step, `HTTP ${response.status}`, response.status === 401 || response.status === 403)
  }
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0]
    const separator = pair.indexOf('=')
    if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
  }
  if (cookies.size) jar.set(host, cookies)
  const value: unknown = await response.json().catch(() => null)
  if (!isObject(value) || (value.status === undefined && value.code === undefined && !Object.hasOwn(value, 'data'))) {
    throw failed(step, '响应格式无效', false)
  }
  for (const code of [value.status, value.code]) {
    if (code !== undefined && code !== 0) {
      if (typeof code !== 'number') throw failed(step, '业务状态无效', false)
      throw failed(step, `业务码 ${code}`, authentication || code === 401 || code === 403)
    }
  }
  return value.data
}

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' }, body: JSON.stringify(body) }
}

function tokenFrom(data: unknown, step: string): string {
  if (!isObject(data) || typeof data.token !== 'string' || !data.token) throw failed(step, '响应缺少令牌', false)
  return data.token
}

function boundUid(data: unknown): string {
  if (!isObject(data) || !Array.isArray(data.list)) throw failed('角色绑定', '响应格式无效', false)
  for (const channel of data.list) {
    if (!isObject(channel) || !Array.isArray(channel.bindingList)) throw failed('角色绑定', '响应格式无效', false)
    for (const binding of channel.bindingList) {
      if (isObject(binding) && typeof binding.uid === 'string' && /^\d+$/.test(binding.uid)) return binding.uid
    }
  }
  throw failed('角色绑定', '未找到已创建的角色', false)
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function parseRecord(value: unknown, category: { id: string; name: string }, appId: string, uid: string): GachaRecord {
  if (!isObject(value) || typeof value.charId !== 'string' || !value.charId ||
      typeof value.charName !== 'string' ||
      (typeof value.gachaTs !== 'string' && typeof value.gachaTs !== 'number') ||
      (typeof value.gachaTs === 'string' && !/^\d+$/.test(value.gachaTs)) ||
      typeof value.pos !== 'number' || !Number.isSafeInteger(value.pos) || value.pos < 0 ||
      typeof value.rarity !== 'number' || !Number.isInteger(value.rarity) ||
      value.rarity < 0 || value.rarity > HYPERGRYPH.topRank) {
    throw failed('寻访记录', '记录字段无效', false)
  }
  const timestampMs = Number(value.gachaTs)
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0 || !Number.isFinite(new Date(timestampMs).getTime())) {
    throw failed('寻访记录', '记录时间无效', false)
  }
  const poolId = typeof value.poolId === 'string' ? value.poolId : category.id
  const bannerName = (typeof value.poolName === 'string' ? value.poolName : category.name).replace(/\s+/g, ' ')
  return {
    id: `arknights:${uid}:${timestampMs}:${value.pos}:${value.charId}`,
    appId, game: 'arknights', uid, gachaType: category.id, poolId, bannerName,
    itemId: value.charId, itemName: value.charName, rankType: value.rarity,
    time: formatTime(timestampMs), timestampMs, seq: String(value.pos)
  }
}

export async function fetchArknightsGacha(
  accountToken: string,
  appId: string,
  cancellation?: AbortSignal
): Promise<GachaRecord[]> {
  const timeout = AbortSignal.timeout(5 * 60_000)
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout
  const meta = HYPERGRYPH
  const jar: CookieJar = new Map()
  await request(jar, `${meta.asBase}/user/info/v1/basic?token=${encodeURIComponent(accountToken)}`, '账号验证', signal, {}, true)
  const oauth = tokenFrom(await request(jar, `${meta.asBase}/user/oauth2/v2/grant`, '账号授权', signal,
    jsonPost({ token: accountToken, appCode: meta.appCode, type: 1 }), true), '账号授权')
  const uid = boundUid(await request(jar,
    `${meta.bindingBase}/account/binding/v1/binding_list?token=${encodeURIComponent(oauth)}&appCode=arknights`,
    '角色绑定', signal))
  const u8token = tokenFrom(await request(jar, `${meta.bindingBase}/account/binding/v1/u8_token_by_uid`, '角色授权', signal,
    jsonPost({ token: oauth, uid })), '角色授权')
  const roleHeaders = { 'x-role-token': u8token }
  await request(jar, `${meta.akBase}/user/api/role/login`, '角色登录', signal,
    jsonPost({ token: u8token, source_from: '', share_type: '', share_by: '' }))
  await request(jar, `${meta.akBase}/user/api/role/info?source_from=&share_type=&share_by=`, '角色信息', signal,
    { headers: roleHeaders })
  const headers = { ...roleHeaders, 'x-account-token': accountToken }
  const categories = await request(jar, `${meta.akBase}/user/api/inquiry/gacha/cate?uid=${encodeURIComponent(uid)}`,
    '寻访分类', signal, { headers })
  if (!Array.isArray(categories) || !categories.every(
    (category): category is { id: string; name: string } => isObject(category) &&
      typeof category.id === 'string' && Boolean(category.id) && typeof category.name === 'string'
  ) || new Set(categories.map(({ id }) => id)).size !== categories.length) {
    throw failed('寻访分类', '响应格式无效', false)
  }

  const records = new Map<string, GachaRecord>()
  try {
    for (const category of categories) {
      const url = new URL(`${meta.akBase}/user/api/inquiry/gacha/history`)
      url.searchParams.set('uid', uid)
      url.searchParams.set('category', category.id)
      url.searchParams.set('size', String(PAGE_SIZE))
      const seen = new Set<string>()
      for (let page = 0; page < PAGE_LIMIT; page++) {
        const data = await request(jar, url, '寻访记录', signal, { headers })
        if (!isObject(data) || !Array.isArray(data.list) || data.list.length > PAGE_SIZE ||
            typeof data.hasMore !== 'boolean' || (data.hasMore && data.list.length === 0)) {
          throw failed('寻访记录', '分页格式无效', false)
        }
        const list = data.list.map((value) => parseRecord(value, category, appId, uid))
        for (const record of list) records.set(record.id, record)
        if (!data.hasMore) break
        const last = list[list.length - 1]
        const cursor = `${last.timestampMs}:${last.seq}`
        if (seen.has(cursor)) throw failed('寻访记录', '分页游标未推进', false)
        if (page === PAGE_LIMIT - 1) throw failed('寻访记录', '达到分页上限', false)
        seen.add(cursor)
        url.searchParams.set('pos', last.seq!)
        url.searchParams.set('gachaTs', String(last.timestampMs))
      }
    }
  } catch (error) {
    if (records.size === 0) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}。已获取 ${records.size} 条但尚未保存，原有记录已保留`, { cause: error })
  }
  return [...records.values()]
}
