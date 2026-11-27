import { Worker } from 'worker_threads'
import type { GachaRecordPage, GachaStats } from '@shared/types'
import gachaIndexWorker from '../workers/gachaIndexWorker?modulePath'
import type { IndexRequest, IndexResponse } from './gachaIndexMessages'

const IDLE_MS = 60_000
const REQUEST_MS = 45_000

interface Pending {
  resolve: (value: GachaStats | GachaRecordPage) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

/** One lazy index worker serves large histories and releases them after idle. */
export class GachaIndexClient {
  private worker: Worker | undefined
  private idle: NodeJS.Timeout | undefined
  private id = 0
  private readonly pending = new Map<number, Pending>()

  async request(input: Omit<IndexRequest, 'id'>): Promise<GachaStats | GachaRecordPage> {
    const worker = this.worker ??= this.start()
    clearTimeout(this.idle)
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.stop(new Error('统计抽卡记录超时'))
      }, REQUEST_MS)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        worker.postMessage({ ...input, id } satisfies IndexRequest)
      } catch (error) {
        void this.stop(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private start(): Worker {
    const worker = new Worker(gachaIndexWorker, { resourceLimits: { maxOldGenerationSizeMb: 768 } })
    worker.on('message', (answer: IndexResponse) => {
      const job = this.pending.get(answer.id)
      if (!job || this.worker !== worker) return
      clearTimeout(job.timeout)
      this.pending.delete(answer.id)
      if ('error' in answer) job.reject(new Error(answer.error))
      else job.resolve(answer.value)
      if (!this.pending.size) this.idle = setTimeout(() => { void this.stop() }, IDLE_MS).unref()
    })
    worker.on('error', error => {
      if (this.worker === worker) void this.stop(error)
    })
    worker.on('exit', () => {
      if (this.worker === worker) void this.stop(new Error('抽卡索引已退出'))
    })
    worker.unref()
    return worker
  }

  async stop(error = new Error('抽卡索引已重置')): Promise<void> {
    clearTimeout(this.idle)
    const worker = this.worker
    this.worker = undefined
    for (const job of this.pending.values()) {
      clearTimeout(job.timeout)
      job.reject(error)
    }
    this.pending.clear()
    if (worker) await worker.terminate().catch(() => undefined)
  }
}
