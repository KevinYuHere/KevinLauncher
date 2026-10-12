/**
 * A single hook for "the launcher is about to exit or restart".
 *
 * It exists so state that is normally flushed lazily (an active play session,
 * a debounced save) is written before the process ends — including the explicit
 * `app.relaunch() + app.exit(0)` paths in the update / data-dir flows, which do
 * not go through `before-quit`.
 */
type FlushFn = () => Promise<void> | void

let flushHandler: FlushFn | null = null
let flushed = false

/** Register the shutdown handler (called once, from `registerIpc`). */
export function onBeforeShutdown(handler: FlushFn): void {
  flushHandler = handler
}

/** Run the handler exactly once. Safe to call from several exit paths. */
export async function flushBeforeShutdown(): Promise<void> {
  if (flushed) return
  flushed = true
  try {
    await flushHandler?.()
  } catch {
    /* never block exit on a flush failure */
  }
}
