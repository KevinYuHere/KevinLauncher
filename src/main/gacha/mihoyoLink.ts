import { MIHOYO, type MiHoYoGame } from './metadata'

const PAGE_FIELDS = new Set(['gacha_type', 'real_gacha_type', 'page', 'size', 'end_id'])

function pageMatches(page: string, prefix: string): boolean {
  if (!page.startsWith(prefix)) return false
  const suffix = page.slice(prefix.length)
  return suffix === '' || suffix.startsWith('/') || /^-v\d+(\/|$)/.test(suffix)
}

/**
 * Accept only the selected game's HoYo accounts page or history endpoint.
 * Separate the endpoint from the opaque query fields used for authentication.
 */
export function parseMiHoYoLink(game: MiHoYoGame, input: string): { endpoint: string; query: string } {
  let link: URL
  try {
    link = new URL(input.trim())
  } catch {
    throw new Error('请提供完整的抽卡记录链接')
  }
  if (link.protocol !== 'https:' || link.username || link.password) {
    throw new Error('请使用官方 HTTPS 抽卡记录链接')
  }

  const meta = MIHOYO[game]
  const address = link.origin + link.pathname
  const regions = ['cn', 'overseas'] as const
  let region: (typeof regions)[number] | undefined
  let endpoint: string | undefined
  let page = false
  for (const [index, candidate] of regions.entries()) {
    const { main, aliases = [] } = meta.history[candidate]
    if (pageMatches(address, meta.urlPrefixes[index])) {
      endpoint = main
      region = candidate
      page = true
      break
    }
    if (address === main || aliases.includes(address)) {
      endpoint = address
      region = candidate
      break
    }
  }
  if (!endpoint) throw new Error('链接不是所选游戏的官方抽卡记录链接')

  let raw = link.search.slice(1)
  if (page && !link.searchParams.has('authkey')) {
    const routeQuery = /^#\/log\?(.+)$/.exec(link.hash)?.[1]
    if (routeQuery) raw = [raw, routeQuery].filter(Boolean).join('&')
  }
  const params = new URLSearchParams(raw)
  const auth = params.getAll('authkey')
  if (auth.length !== 1 || !auth[0].trim()) throw new Error('抽卡链接缺少有效授权')
  const gameBiz = params.get('game_biz')
  if (gameBiz && gameBiz !== meta.gameCode + (region === 'cn' ? '_cn' : '_global')) {
    throw new Error('抽卡链接的游戏或区服与地址不匹配')
  }

  // URLSearchParams serialisation changes spaces and the escaping of some
  // characters. Read names structurally but keep the original value encoding.
  const query = raw.split('&').filter(part => {
    const name = new URLSearchParams(part).keys().next().value
    return name !== undefined && !PAGE_FIELDS.has(name)
  }).join('&')
  return { endpoint, query }
}
