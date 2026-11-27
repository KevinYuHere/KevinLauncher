import { promises as fs } from 'fs'
import { Worker } from 'worker_threads'
import type { GachaGame, GachaRecord } from '@shared/types'
import gachaImportWorker from '../workers/gachaImportWorker?modulePath'
import { decodeGachaArchive } from './gachaFormats'

const MIB = 1024 * 1024
const MAX_SIZE = 128 * MIB

export async function readGachaArchive(file: string, appId: string, game: GachaGame): Promise<GachaRecord[]> {
  const info = await fs.stat(file)
  if (!info.isFile() || info.size > MAX_SIZE) throw new Error('请选择小于 128 MiB 的抽卡记录文件')
  if (info.size <= MIB) return decodeGachaArchive(await fs.readFile(file, 'utf8'), appId, game)
  const worker = new Worker(gachaImportWorker, {
    workerData: { file, appId, game },
    resourceLimits: { maxOldGenerationSizeMb: 768 }
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    return await new Promise<GachaRecord[]>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('读取抽卡记录文件超时')), 60_000)
      worker.once('message', (value: { records?: GachaRecord[]; error?: string }) => {
        if (value.records) resolve(value.records)
        else reject(new Error(value.error ?? '无法读取抽卡记录文件'))
      })
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('抽卡文件处理已中止')))
    })
  } finally {
    clearTimeout(timeout)
    await worker.terminate()
  }
}
