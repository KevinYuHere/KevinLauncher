// Temporary performance probe for the wallpaper switch path (diagnostics only).
export interface PerfEntry {
  t: number
  ev: string
  detail?: unknown
}

const log: PerfEntry[] = []

export function perf(ev: string, detail?: unknown): void {
  log.push({ t: Math.round(performance.now()), ev, detail })
  if (log.length > 400) log.splice(0, log.length - 400)
  ;(globalThis as unknown as { __klPerf?: PerfEntry[] }).__klPerf = log
}

try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration > 60) perf('longtask', Math.round(entry.duration))
    }
  })
  observer.observe({ entryTypes: ['longtask'] })
} catch {
  /* unsupported */
}
