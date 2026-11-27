import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArknightsAuthError, fetchArknightsGacha } from '../src/main/gacha/arknights'

const data = (value: unknown) => Response.json({ code: 0, data: value })
const line = { charId: 'char_100', charName: '测试干员', rarity: 5, gachaTs: '1767879000000', pos: 2 }

function stub(...history: Response[]) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    switch (url.pathname) {
      case '/user/info/v1/basic': return Response.json({ status: 0 })
      case '/user/oauth2/v2/grant': return data({ token: 'oauth-fixture' })
      case '/account/binding/v1/binding_list': return data({ list: [{ bindingList: [{ uid: '1000' }] }] })
      case '/account/binding/v1/u8_token_by_uid': return data({ token: 'role-fixture' })
      case '/user/api/role/login':
      case '/user/api/role/info': return data({})
      case '/user/api/inquiry/gacha/cate': return data([{ id: 'normal', name: '标准寻访' }])
      case '/user/api/inquiry/gacha/history':
        requests.push(url)
        return history.shift() ?? new Response(null, { status: 500 })
      default: throw new Error('Unknown fixture request')
    }
  }))
  return requests
}

afterEach(() => vi.unstubAllGlobals())

describe('明日方舟寻访接口', () => {
  it('validates the complete page chain and retains the native position and time', async () => {
    const requests = stub(
      data({ list: [line], hasMore: true }),
      data({ list: [{ ...line, pos: 1, charId: 'char_999' }], hasMore: false })
    )
    const records = await fetchArknightsGacha('fixture', 'app')
    expect(records.map(({ seq }) => seq)).toEqual(['2', '1'])
    expect(records[0]).toMatchObject({ uid: '1000', timestampMs: Number(line.gachaTs), rankType: 5 })
    expect(requests[1].searchParams.get('pos')).toBe('2')
    expect(requests[1].searchParams.get('gachaTs')).toBe(line.gachaTs)
  })

  it.each([
    () => new Response(null, { status: 503 }),
    () => Response.json({ code: 9, data: { list: [], hasMore: false } }),
    () => data({ list: [line], hasMore: true }),
    () => data({ list: [{ ...line, rarity: 10 }], hasMore: false })
  ])('reports incomplete history instead of returning partial records', async (badResponse) => {
    stub(data({ list: [line], hasMore: true }), badResponse())
    await expect(fetchArknightsGacha('fixture', 'app')).rejects.toThrow('已获取 1 条但尚未保存')
  })

  it('distinguishes rejected authentication from unavailable data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response(null, { status: 401 })))
    await expect(fetchArknightsGacha('fixture', 'app')).rejects.toBeInstanceOf(ArknightsAuthError)
    vi.stubGlobal('fetch', vi.fn(() => new Response(null, { status: 503 })))
    await expect(fetchArknightsGacha('fixture', 'app')).rejects.not.toBeInstanceOf(ArknightsAuthError)
  })
})
