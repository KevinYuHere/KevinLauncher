import type { GachaRecord } from '@shared/types'
import { HYPERGRYPH } from './metadata'

type CookieJar = Record<string, Record<string, string>>

interface JsonResponse {
  status?: number
  code?: number
  msg?: string
  message?: string
  data?: unknown
}

async function request(
  jar: CookieJar,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; json: JsonResponse | null; text: string }> {
  const host = new URL(url).host
  const cookie = Object.entries(jar[host] ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

  const headers: Record<string, string> = { ...(init?.headers ?? {}) }
  if (cookie) headers['Cookie'] = cookie

  const res = await fetch(url, { method: init?.method, headers, body: init?.body })

  const setCookies = res.headers.getSetCookie?.() ?? []
  for (const raw of setCookies) {
    const pair = raw.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) {
      jar[host] ??= {}
      jar[host][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
  }

  const text = await res.text()
  let json: JsonResponse | null = null
  try {
    json = JSON.parse(text) as JsonResponse
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

function formatMs(value: string | number): string {
  const ms = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
}

/**
 * Full Hypergryph gacha (寻访记录) chain: account token -> oauth -> binding ->
 * u8 token -> role login/info -> categories -> history.
 * `accountToken` is the token from https://web-api.hypergryph.com/account/info/hg
 */
export async function fetchArknightsGacha(
  accountToken: string,
  appId: string
): Promise<GachaRecord[]> {
  const meta = HYPERGRYPH
  const jar: CookieJar = {}

  const basic = await request(
    jar,
    `${meta.asBase}/user/info/v1/basic?token=${encodeURIComponent(accountToken)}`
  )
  if (basic.json?.status !== 0) throw new Error('账号 token 无效或已过期')

  const grant = await request(jar, `${meta.asBase}/user/oauth2/v2/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ token: accountToken, appCode: meta.appCode, type: 1 })
  })
  const oauth = (grant.json?.data as { token?: string } | undefined)?.token
  if (!oauth) throw new Error('获取 OAuth token 失败')

  const bind = await request(
    jar,
    `${meta.bindingBase}/account/binding/v1/binding_list?token=${encodeURIComponent(
      oauth
    )}&appCode=arknights`
  )
  const binding = bind.json?.data as
    | { list?: { bindingList?: { uid?: string }[] }[] }
    | undefined
  const uid = binding?.list?.[0]?.bindingList?.[0]?.uid
  if (!uid) throw new Error('未找到明日方舟角色绑定（请确认账号已创建角色）')

  const u8 = await request(jar, `${meta.bindingBase}/account/binding/v1/u8_token_by_uid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ token: oauth, uid })
  })
  const u8token = (u8.json?.data as { token?: string } | undefined)?.token
  if (!u8token) throw new Error('获取角色 token 失败')

  await request(jar, `${meta.akBase}/user/api/role/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: u8token, source_from: '', share_type: '', share_by: '' })
  })
  await request(
    jar,
    `${meta.akBase}/user/api/role/info?source_from=&share_type=&share_by=`,
    { headers: { 'x-role-token': u8token } }
  )

  const cate = await request(
    jar,
    `${meta.akBase}/user/api/inquiry/gacha/cate?uid=${encodeURIComponent(uid)}`,
    { headers: { 'x-account-token': accountToken, 'x-role-token': u8token } }
  )
  const categories = (cate.json?.data as { id: string; name: string }[] | undefined) ?? []

  const out: GachaRecord[] = []
  for (const category of categories) {
    const categoryName = category.name.replace(/\s+/g, ' ')
    let pos: string | undefined
    let gachaTs: string | undefined
    for (let page = 0; page < 2000; page++) {
      const url = new URL(`${meta.akBase}/user/api/inquiry/gacha/history`)
      url.searchParams.set('uid', uid)
      url.searchParams.set('category', category.id)
      url.searchParams.set('size', '10')
      if (pos) url.searchParams.set('pos', pos)
      if (gachaTs) url.searchParams.set('gachaTs', gachaTs)

      const res = await request(jar, url.toString(), {
        headers: { 'x-account-token': accountToken, 'x-role-token': u8token }
      })
      const data = res.json?.data as
        | {
            list?: {
              poolId?: string
              poolName?: string
              charId?: string
              charName?: string
              rarity?: number
              isNew?: boolean
              gachaTs?: string
              pos?: number
            }[]
            hasMore?: boolean
          }
        | undefined
      const list = data?.list ?? []
      if (list.length === 0) break

      for (const item of list) {
        const itemId = item.charId ?? item.poolId ?? ''
        out.push({
          id: `arknights:${uid}:${item.gachaTs}:${item.pos}:${itemId}`,
          appId,
          game: 'arknights',
          uid,
          gachaType: category.id,
          poolId: item.poolId ?? category.id,
          bannerName: item.poolName ? item.poolName.replace(/\s+/g, ' ') : categoryName,
          itemId,
          itemName: item.charName ?? '（未知）',
          rankType: item.rarity ?? 0,
          time: formatMs(item.gachaTs ?? ''),
          seq: item.pos != null ? String(item.pos) : undefined
        })
      }

      const last = list[list.length - 1]
      pos = String(last.pos ?? 0)
      gachaTs = String(last.gachaTs ?? '')
      if (!data?.hasMore) break
    }
  }
  return out
}
