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
type ShutdownHandler = (beforeDispose?: FlushFn) => Promise<void> | void

let flushHandler: ShutdownHandler | null = null
let flush: Promise<void> | undefined

/** Register the shutdown handler (called once, from `registerIpc`). */
export function onBeforeShutdown(handler: ShutdownHandler): void {
  flushHandler = handler
}

/** Run any activation after saving, inside the recoverable shutdown phase. */
export function flushBeforeShutdown(beforeDispose?: FlushFn): Promise<void> {
  if (flush && beforeDispose) return Promise.reject(new Error('启动器正在关闭'))
  flush ??= Promise.resolve()
    .then(() => flushHandler ? flushHandler(beforeDispose) : beforeDispose?.())
    .then(flushLauncherLogs)
    .catch((error) => {
      flush = undefined
      log(`shutdown: could not flush user data (${String(error)})`)
      throw error
    })
  return flush
}
