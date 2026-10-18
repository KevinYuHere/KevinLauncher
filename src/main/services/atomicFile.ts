import { promises as fs } from 'fs'
import { dirname } from 'path'

/**
 * Small persistence helpers shared by the data stores.
 *
 * Two failure modes used to be able to silently destroy user data:
 *  1. a non-atomic write (`writeFile`) truncated by a crash, and
 *  2. a read/parse failure treated as "empty", after which the next write would
 *     overwrite the real file with an empty one.
 * `writeFileAtomic` fixes (1); `loadJsonSafe` lets stores tell "no file yet"
 * apart from "could not read" so they can avoid (2).
 */

/** Per-file write queue: serialises concurrent saves so they can never interleave. */
const writeChains = new Map<string, Promise<void>>()

/**
 * Write a file via a temp file + rename, so it is never truncated by a crash.
 *
 * The temp name is unique per write **and** writes to the same file are chained,
 * because two overlapping saves used to race on a shared `<file>.tmp`: the
 * shorter write left the longer one's tail behind, producing valid JSON with
 * stray trailing bytes (`...}\n}\n}`) that then failed to parse on next launch.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`
    await fs.writeFile(tmp, data)
    try {
      await fs.rename(tmp, file)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  })
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  writeChains.set(file, settled)
  void settled.then(() => {
    if (writeChains.get(file) === settled) writeChains.delete(file)
  })
  return next
}

export type JsonLoadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  /** The file was read but is not valid JSON (really corrupt). */
  | { status: 'parse-error'; error: unknown }
  /** The file could not be read at all (locked / permission / transient). */
  | { status: 'read-error'; error: unknown }

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'

/**
 * Parse JSON, tolerating **trailing junk** after the root value. The concurrent
 * write race of 1.2.2 could leave a valid object followed by the tail of a
 * longer one (`...}\n}\n}`); parsing just the balanced root recovers the data.
 * Returns `undefined` when even the root value is not valid JSON.
 */
export function parseJsonLenient<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    /* try to recover the balanced root value below */
  }
  let i = 0
  while (i < raw.length && isSpace(raw[i])) i++
  const open = raw[i]
  if (open !== '{' && open !== '[') return undefined
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(0, i + 1)) as T
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Read + parse a JSON file, retrying transient read failures (a store file can
 * be briefly locked by a backup/AV scanner). Returns a discriminated result so
 * callers can distinguish a missing file from one that merely could not be read.
 *
 * A file with trailing junk after the root value is **recovered** (not treated
 * as corrupt) so the old 1.2.2 corruption self-heals on the next read.
 */
export async function loadJsonSafe<T>(file: string, attempts = 3): Promise<JsonLoadResult<T>> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      lastError = error
      await delay(150 * (attempt + 1))
      continue
    }
    const value = parseJsonLenient<T>(raw)
    if (value !== undefined) return { status: 'ok', value }
    try {
      JSON.parse(raw)
    } catch (error) {
      return { status: 'parse-error', error }
    }
    return { status: 'parse-error', error: new Error('invalid JSON') }
  }
  return { status: 'read-error', error: lastError }
}

/** Rename a corrupt store file aside (`<file>.corrupt`) so it can be recovered. */
export async function quarantineFile(file: string): Promise<boolean> {
  try {
    await fs.rename(file, `${file}.corrupt`)
    return true
  } catch {
    return false
  }
}
