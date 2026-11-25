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
    await store.importRecords('new', await store.exportUigf('old', 'fixture'))
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
})
