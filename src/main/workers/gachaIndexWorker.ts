import { parentPort } from 'worker_threads'
import { readFile } from 'fs/promises'
import { parseJsonLenient } from '../services/atomicFile'
import type { GachaRecord } from '@shared/types'
import { GachaIndex } from '../gacha/gachaIndex'
import type { IndexRequest, IndexResponse } from '../gacha/gachaIndexMessages'

const MAX_DATASETS = 2
const entries = new Map<string, { revision: number; index: Promise<GachaIndex> }>()

function indexFor({ file, revision, appId }: IndexRequest): Promise<GachaIndex> {
  const current = entries.get(file)
  const entry = current?.revision === revision ? current : {
    revision,
    index: readFile(file, 'utf8').then((raw) => {
      const parsed = parseJsonLenient<{ records: GachaRecord[] }>(raw)
      if (!Array.isArray(parsed?.records)) throw new Error('无法索引抽卡记录')
      return new GachaIndex(parsed.records.map((record) => ({ ...record, appId, uid: record.uid ?? '' })), false)
    })
  }
  entries.delete(file)
  entries.set(file, entry)
  while (entries.size > MAX_DATASETS) entries.delete(entries.keys().next().value!)
  return entry.index
}

parentPort?.on('message', (request: IndexRequest) => {
  const { id, query, file, revision } = request
  function send(response: IndexResponse): void {
    parentPort?.postMessage(response)
  }
  void indexFor(request).then((index) => send({
    id,
    value: query.type === 'stats'
      ? index.stats(query.game)
      : index.page(query.group, query.showSecond, query.offset, query.limit)
  })).catch((error: unknown) => {
    if (entries.get(file)?.revision === revision) entries.delete(file)
    send({ id, error: error instanceof Error ? error.message : String(error) })
  })
})
