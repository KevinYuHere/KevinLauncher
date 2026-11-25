/**
 * A single hook for "the launcher is about to exit or restart".
 *
 * It exists so state that is normally flushed lazily (an active play session,
 * a debounced save) is written before the process ends — including the explicit
 * `app.relaunch() + app.exit(0)` paths in the update / data-dir flows, which do
 * not go through `before-quit`.
 */
import { flushLauncherLogs, log } from './logger'

type FlushFn = () => Promise<void> | void

let flushHandler: FlushFn | null = null
let flush: Promise<void> | undefined

/** Register the shutdown handler (called once, from `registerIpc`). */
export function onBeforeShutdown(handler: FlushFn): void {
  flushHandler = handler
}

/** Share an in-flight flush and let the user retry after a storage failure. */
export function flushBeforeShutdown(): Promise<void> {
  flush ??= Promise.resolve()
    .then(() => flushHandler?.())
    .then(flushLauncherLogs)
    .catch((error) => {
      flush = undefined
      log(`shutdown: could not flush user data (${String(error)})`)
      throw error
    })
  return flush
}
