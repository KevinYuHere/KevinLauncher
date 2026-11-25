import { isMainThread } from 'node:worker_threads'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_PENDING_LINES = 256
const MAX_LINE = 4096
const pending: string[] = []
let dropped = 0
let operations = Promise.resolve()
let writing = false
let maintenance = 0

function serialize(part: unknown): string {
  if (typeof part === 'string') return part
  if (part instanceof Error) return `${part.name}: ${part.message}`
  try { return JSON.stringify(part) }
  catch { return String(part) }
}

function redact(message: string): string {
  return message
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/([?&](?:authkey|token|access_token|refresh_token|stoken|ltoken|cred|signature|sign|key|password|secret|api_key)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/("(?:authkey|access_?token|refresh_?token|token|stoken|ltoken|cred|authorization|cookie|set-cookie|secret|password)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(/(--(?:password|passwd|token|api[_-]?key|secret|authkey)[= ]+)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1[redacted]')
}

function logFile(): string {
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'launcher.log')
}

export async function launcherLogBytes(): Promise<number> {
  let bytes = 0
  const file = logFile()
  for (const path of [file, `${file}.1`]) {
    try { bytes += (await fs.lstat(path)).size }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return bytes
}

function takeBatch(): string {
  const lines = pending.splice(0)
  if (dropped > 0) {
    lines.push(`[${new Date().toISOString()}] log: ${dropped} lines dropped while the log queue was full\n`)
    dropped = 0
  }
  return lines.join('')
}

async function writeBatch(batch: string): Promise<void> {
  if (!batch) return
  const file = logFile()
  try {
    const { size } = await fs.stat(file)
    if (size + Buffer.byteLength(batch) > MAX_LOG_BYTES) {
      await fs.rm(`${file}.1`, { force: true })
      await fs.rename(file, `${file}.1`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.appendFile(file, batch)
}

function schedule(): void {
  if (writing || maintenance > 0 || pending.length === 0) return
  writing = true
  const batch = takeBatch()
  operations = operations.then(() => writeBatch(batch)).catch(() => undefined).finally(() => {
    writing = false
    schedule()
  })
}

export function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${redact(parts.map(serialize).join(' ')).slice(0, MAX_LINE)}\n`
  console.log(line.trimEnd())
  if (!isMainThread) return
  if (pending.length >= MAX_PENDING_LINES) dropped++
  else pending.push(line)
  schedule()
}

export async function flushLauncherLogs(): Promise<void> {
  while (writing || maintenance > 0 || pending.length > 0) {
    schedule()
    await operations
  }
}

/** Run deletion in the writer's queue so rotations/appends cannot race it. */
export function clearLauncherLogs(): Promise<{ bytes: number; failures: string[] }> {
  maintenance++
  const beforeClear = takeBatch()
  const action = operations.then(async () => {
    let bytes = 0
    const failures: string[] = []
    await writeBatch(beforeClear).catch((error) => failures.push(String(error)))
    const file = logFile()
    for (const path of [file, `${file}.1`]) {
      try {
        const { size } = await fs.lstat(path)
        await fs.unlink(path)
        bytes += size
      } catch (error) {
        const failure = error as NodeJS.ErrnoException
        if (failure.code !== 'ENOENT') failures.push(`${path}：${failure.code ?? failure.message}`)
      }
    }
    return { bytes, failures }
  })
  operations = action.then(() => undefined, () => undefined).finally(() => {
    maintenance--
    schedule()
  })
  return action
}
