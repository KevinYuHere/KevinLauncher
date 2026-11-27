// Independently implemented resource scheduler and resumable job sequence.
import { availableParallelism } from 'os'
import { retryHoYo } from './hoyoFiles'

export async function forEachResource<T>(
  items: readonly T[], signal: AbortSignal, action: (item: T, signal: AbortSignal) => Promise<void>,
  retry = true, concurrency = availableParallelism()
): Promise<void> {
  signal.throwIfAborted()
  if (!items.length) return
  const stop = new AbortController()
  const token = AbortSignal.any([signal, stop.signal])
  let index = 0
  let failure: { reason: unknown } | undefined
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    try {
      while (!token.aborted && index < items.length) {
        const item = items[index++]
        if (retry) await retryHoYo(() => action(item, token), token)
        else await action(item, token)
      }
    } catch (reason) {
      failure ??= { reason }
      stop.abort()
    }
  })
  await Promise.all(workers)
  if (failure) throw failure.reason
  signal.throwIfAborted()
}

/** Combine absolute resource counters, including bytes restored or rolled back on retry. */
export function resourceProgress(total: number, report: (done: number, total: number, name: string) => void) {
  let done = 0
  const counts = new Map<string, number>()
  return (name: string, bytes: number): void => {
    done += bytes - (counts.get(name) ?? 0)
    counts.set(name, bytes)
    total = Math.max(total, done)
    report(done, total, name)
  }
}

export interface HoYoStepContext {
  signal: AbortSignal
  progress(done: number, total: number): void
  phase(message: string, extracting?: boolean): void
}
export type HoYoStep = (context: HoYoStepContext) => Promise<void>

/** Retain completed steps throughout pause/retry; only the active step is re-entered. */
export class HoYoSteps {
  private next = 0
  constructor(private readonly steps: HoYoStep[], private readonly dispose: () => Promise<void>,
    private readonly suspend?: () => Promise<void>
  ) {}
  async run(context: HoYoStepContext): Promise<void> {
    while (this.next < this.steps.length) {
      context.signal.throwIfAborted()
      await this.steps[this.next](context)
      this.next++
    }
  }
  close(): Promise<void> { return this.dispose() }
  park(): Promise<void> { return this.suspend?.() ?? Promise.resolve() }
}
