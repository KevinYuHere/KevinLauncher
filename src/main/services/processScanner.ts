import { Worker } from 'worker_threads'
import processWorkerPath from '../workers/processWorker?modulePath'
import { ProcessTree, type ProcInfo } from './processTree'

interface Pending {
  resolve: (procs: ProcInfo[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Runs the (relatively heavy) process enumeration in a worker thread so the
 * main process event loop — and therefore the UI — never blocks on it.
 * Falls back to an inline snapshot if the worker is unavailable.
 */
export class ProcessScanner {
  private worker: Worker | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private queue: Promise<void> = Promise.resolve()

  snapshot(): Promise<ProcInfo[]> {
    const run = this.queue
      .then(() => this.request())
      .catch(() => ProcessTree.snapshot())
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private request(): Promise<ProcInfo[]> {
    return new Promise<ProcInfo[]>((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('process snapshot timeout'))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ensureWorker().postMessage({ id })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        ProcessTree.snapshot().then(resolve, reject)
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(processWorkerPath)
    worker.on('message', (message: { id: number; ok: boolean; procs?: ProcInfo[]; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.procs ?? [])
      else pending.reject(new Error(message.error ?? 'worker error'))
    })
    worker.on('error', () => {
      this.worker = null
    })
    worker.on('exit', () => {
      this.worker = null
    })
    this.worker = worker
    return worker
  }

  dispose(): void {
    void this.worker?.terminate()
    this.worker = null
  }
}
