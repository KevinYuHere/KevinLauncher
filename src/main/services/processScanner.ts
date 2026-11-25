import { ProcessTree, type ProcInfo } from './processTree'

/** The external CIM command runs off-process. Consumers share one bounded scan. */
export class ProcessScanner {
  private readonly controller = new AbortController()
  private pending: Promise<ProcInfo[]> | undefined

  constructor(private readonly scan = ProcessTree.snapshot) {}

  snapshot(): Promise<ProcInfo[]> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('进程扫描已关闭'))
    this.pending ??= this.scan(this.controller.signal).finally(() => { this.pending = undefined })
    return this.pending
  }

  async dispose(): Promise<void> {
    this.controller.abort()
    await this.pending?.catch(() => undefined)
  }
}
