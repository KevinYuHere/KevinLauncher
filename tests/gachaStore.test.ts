import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GachaRecord } from '../src/shared/types'
import { GachaStore } from '../src/main/gacha/gachaStore'

let root: string
vi.mock('electron', () => ({
  app: { getPath: () => root, getVersion: () => '2.0.4' }
}))

beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'kl-gacha-store-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

function record(id: string, poolId: string): GachaRecord {
  return {
    id, appId: 'old', game: 'arknights', gachaType: 'limited', poolId,
    bannerName: poolId, uid: '0', itemId: 'fixture', itemName: 'fixture',
    rankType: 4, time: '2026-01-01 00:00:00'
  }
}

describe('GachaStore', () => {
  it('retains separate limited pools after export and import', async () => {
    const store = new GachaStore()
    await store.add('old', [record('1', 'first'), record('2', 'second')])
    const archive = await store.exportArchive('old')
    expect(archive.format).toBe('native')
    await store.importRecords('new', archive.text)
    const before = await store.stats('old')
    const after = await store.stats('new')
    const byGroup = (a: { group: string }, b: { group: string }) => a.group.localeCompare(b.group)
    expect(after.pools.sort(byGroup)).toEqual(before.pools.sort(byGroup))
    expect(after.pools).toHaveLength(2)
  })

  it('writes successful additions before signalling completion and preserves them on reload', async () => {
    const store = new GachaStore()
    await Promise.all([store.add('old', [record('1', 'first')]), store.add('old', [record('2', 'second')])])
    const file = join(root, 'gacha', 'old.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).records).toHaveLength(2)
    await store.reload()
    expect(await store.list('old')).toHaveLength(2)
  })

  it('reports failed writes and retries pending records when flushed', async () => {
    const store = new GachaStore()
    const file = join(root, 'gacha', 'old.json')
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation((source, target) =>
      target === file ? Promise.reject(new Error('locked')) : rename(source, target)
    )
    await expect(store.add('old', [record('1', 'first')])).rejects.toThrow('locked')
    spy.mockRestore()
    await store.flush()
    expect(JSON.parse(await fs.readFile(file, 'utf8')).records).toHaveLength(1)
  })

  it('does not clear a store whose current file could not be read', async () => {
    const store = new GachaStore()
    const file = join(root, 'gacha', 'old.json')
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.mkdir(file)
    await expect(store.clear('old')).rejects.toThrow('无法读取现有抽卡记录')
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  })

  it('uses the source ordering for same-second AK pulls and keeps account histories separate', async () => {
    const store = new GachaStore()
    await store.add('old', [
      { ...record('char1', 'normal'), gachaType: 'normal', uid: '100', seq: '2', rankType: 4 },
      { ...record('char999', 'normal'), gachaType: 'normal', uid: '100', seq: '1', rankType: 5 },
      { ...record('char1', 'normal'), gachaType: 'normal', uid: '200', seq: '2', rankType: 5 },
      { ...record('historical', 'normal'), gachaType: 'normal', uid: '', rankType: 5 }
    ])
    expect(await store.count('old')).toBe(4)
    const { pools } = await store.stats('old', 'arknights')
    expect(pools.find(({ uid }) => uid === '100')).toMatchObject({ count: 2, topPity: 1, pityKnown: true })
    expect(pools.find(({ uid }) => uid === '200')).toMatchObject({ count: 1, topPity: 0, pityKnown: true })
    expect(pools.find(({ uid }) => uid === '')).toMatchObject({ count: 1, pityKnown: false })
    const group = pools.find(({ uid }) => uid === '100')!.group
    const first = await store.page('old', group, true, 0, 1)
    expect(first).toMatchObject({ offset: 0, limit: 1, matched: 2, records: [{ id: 'char1', pityAtPull: 2 }] })
    expect((await store.page('old', group, true, 1, 1)).records[0].id).toBe('char999')
  })
})
