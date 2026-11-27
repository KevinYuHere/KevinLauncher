import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GachaRecord, GachaStats } from '../src/shared/types'
import type { IndexRequest, IndexResponse } from '../src/main/gacha/gachaIndexMessages'

let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'kl-gacha-workers-')) })
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })

async function compile(name: string): Promise<string> {
  const output = join(directory, `${name}.cjs`)
  await build({
    bundle: true, entryPoints: [`src/main/workers/${name}.ts`],
    outfile: output, platform: 'node', format: 'cjs', alias: { '@shared': resolve('src/shared') }
  })
  return output
}

const records = Array.from({ length: 20_040 }, (_, index): GachaRecord => ({
  id: String(index + 1), uid: '10000', game: 'genshin', appId: 'bench',
  gachaType: '301', bannerName: '', itemId: 'test', itemName: '测试物品',
  time: '2026-01-01 00:00:00', rankType: 5, timezone: 8
}))

function nextMessage<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
}

describe('gacha worker integration', () => {
  it('indexes a large file in a real worker and answers later pages from the same revision', async () => {
    const source = join(directory, 'records.json')
    await fs.writeFile(source, JSON.stringify({ version: 1, records }))
    const worker = new Worker(await compile('gachaIndexWorker'))
    try {
      const first = nextMessage<IndexResponse>(worker)
      const request = { id: 1, file: source, appId: 'bench', revision: 1 }
      worker.postMessage({ ...request, query: { type: 'stats', game: 'genshin' } } satisfies IndexRequest)
      const reply = await first
      if ('error' in reply) throw new Error(reply.error)
      const stats = reply.value as GachaStats
      expect(stats.total).toBe(records.length)
      await fs.unlink(source)
      const second = nextMessage<IndexResponse>(worker)
      worker.postMessage({
        ...request, id: 2, query: { type: 'page', group: stats.pools[0].group, showSecond: false, offset: 40, limit: 40 }
      } satisfies IndexRequest)
      expect(await second).toMatchObject({
        id: 2, value: { offset: 40, matched: records.length, records: expect.arrayContaining([expect.objectContaining({ id: '20000' })]) }
      })
    } finally {
      await worker.terminate()
    }
  })

  it('parses and validates a large native archive in a real worker', async () => {
    const file = join(directory, 'import.json')
    await fs.writeFile(file, JSON.stringify({ format: 'kevinlauncher-gacha', version: 1, records }))
    const worker = new Worker(await compile('gachaImportWorker'), {
      workerData: { file, appId: 'new', game: 'genshin' }
    })
    try {
      const result = await nextMessage<{ records: GachaRecord[] }>(worker)
      expect(result.records).toHaveLength(records.length)
      expect(result.records[0]).toMatchObject({ appId: 'new', uid: '10000', timezone: 8 })
    } finally {
      await worker.terminate()
    }
  })
})
