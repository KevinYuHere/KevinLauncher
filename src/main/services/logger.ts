import { app } from 'electron'
import { appendFile, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/** Rotate `launcher.log` at this size (one previous generation is kept). */
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** Only stat the file this often. */
const SIZE_CHECK_INTERVAL = 30_000

let lastSizeCheck = 0

function serialize(part: unknown): string {
  if (typeof part === 'string') return part
  if (part instanceof Error) return `${part.name}: ${part.message}`
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

function logFile(): string {
  return join(app.getPath('userData'), 'launcher.log')
}

/** Renames the log to `launcher.log.1` once it grows past the limit. */
function rotateIfNeeded(file: string): void {
  const now = Date.now()
  if (now - lastSizeCheck < SIZE_CHECK_INTERVAL) return
  lastSizeCheck = now
  try {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    rmSync(`${file}.1`, { force: true })
    renameSync(file, `${file}.1`)
  } catch {
    /* no log file yet */
  }
}

/**
 * Append a line to the launcher log. Writes asynchronously (fire-and-forget) so
 * logging never blocks the main process / UI. The file is rotated at 5 MB so it
 * cannot grow without bound.
 */
export function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map(serialize).join(' ')}\n`
  console.log(line.trimEnd())
  try {
    const file = logFile()
    rotateIfNeeded(file)
    appendFile(file, line, () => {
      /* ignore logging failures */
    })
  } catch {
    /* ignore logging failures */
  }
}
