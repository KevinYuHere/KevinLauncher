import { app } from 'electron'
import { appendFile } from 'fs'
import { join } from 'path'

function serialize(part: unknown): string {
  if (typeof part === 'string') return part
  if (part instanceof Error) return `${part.name}: ${part.message}`
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

/**
 * Append a line to the launcher log. Writes asynchronously (fire-and-forget)
 * so logging never blocks the main process / UI.
 */
export function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map(serialize).join(' ')}\n`
  console.log(line.trimEnd())
  try {
    appendFile(join(app.getPath('userData'), 'launcher.log'), line, () => {
      /* ignore logging failures */
    })
  } catch {
    /* ignore logging failures */
  }
}