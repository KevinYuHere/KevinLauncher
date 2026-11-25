import { parentPort, workerData } from 'worker_threads'
import { readFile } from 'fs/promises'
import type { GachaGame } from '@shared/types'
import { decodeGachaArchive } from '../gacha/gachaFormats'

const { file, appId, game } = workerData as { file: string; appId: string; game: GachaGame }
void readFile(file, 'utf8').then((raw) => {
  parentPort?.postMessage({ records: decodeGachaArchive(raw, appId, game) })
}).catch((error: unknown) => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
})
