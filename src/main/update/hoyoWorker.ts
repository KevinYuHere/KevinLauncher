import type { Worker } from 'worker_threads'
import { createHoYoDownloadWorker } from './hoyoTransportBridge'
import { hoyoPortBudget } from './hoyoNetwork'
import type { HoYoStepContext } from './hoyoSchedule'
import type { getSophonPlan } from './sophonPlan'

export interface SophonSetup {
  gameId: string
  userData: string
  launcherVersion: string
  dir: string
  plan: Awaited<ReturnType<typeof getSophonPlan>>
  version: string
  predownload: boolean
  hpatchz: string
  blacklist: string[]
  work?: string
  cacheTarget?: string
}
export type SophonCommand = { type: 'prepare'; setup: SophonSetup } | { type: 'update' | 'verify' | 'park' | 'dispose' }
type Reply = { type: 'done' } | { type: 'error'; message: string } | { type: 'progress'; done: number; total: number }

export class HoYoWorkerStopped extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HoYoWorkerStopped'
  }
}

export class HoYoWorker {
  private readonly worker: Worker
  private failure?: HoYoWorkerStopped
  private closing?: Promise<void>
  constructor(path: string) {
    try { this.worker = createHoYoDownloadWorker(path, { hoyoPortBudget }) } catch (error) {
      throw new HoYoWorkerStopped('游戏更新工作线程启动失败', { cause: error })
    }
    this.worker.on('exit', code => { this.failure ??= new HoYoWorkerStopped('游戏更新工作线程已退出 (' + code + ')') })
    this.worker.on('error', error => { this.failure ??= new HoYoWorkerStopped(error.message, { cause: error }) })
  }
  async run(command: SophonCommand, context: HoYoStepContext): Promise<void> {
    if (this.failure) throw this.failure
    context.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        context.signal.removeEventListener('abort', cancel)
        this.worker.off('error', stopped)
        this.worker.off('exit', stopped)
        this.worker.off('message', receive)
        if (error) reject(error)
        else resolve()
      }
      const stopped = () => finish(this.failure)
      const send = (message: object) => {
        try { this.worker.postMessage(message) } catch (error) {
          this.failure ??= new HoYoWorkerStopped('游戏更新工作线程通信失败', { cause: error })
          finish(this.failure)
        }
      }
      const cancel = () => send({ type: 'cancel' })
      const receive = (reply: Reply) => {
        if (reply.type === 'progress') context.progress(reply.done, reply.total)
        if (reply.type === 'done') finish()
        if (reply.type === 'error') finish(new Error(reply.message))
      }
      this.worker.once('error', stopped)
      this.worker.once('exit', stopped)
      this.worker.on('message', receive)
      context.signal.addEventListener('abort', cancel, { once: true })
      send(command)
    })
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        if (!this.failure) await this.run({ type: 'dispose' }, { signal: new AbortController().signal, progress() {}, phase() {} })
      } finally { await this.worker.terminate() }
    })()
    return this.closing
  }
}
