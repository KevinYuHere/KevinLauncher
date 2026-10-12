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

/** Write a file via a sibling temp file + rename, so it is never truncated. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

export type JsonLoadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  /** The file was read but is not valid JSON (really corrupt). */
  | { status: 'parse-error'; error: unknown }
  /** The file could not be read at all (locked / permission / transient). */
  | { status: 'read-error'; error: unknown }

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read + parse a JSON file, retrying transient read failures (a store file can
 * be briefly locked by a backup/AV scanner). Returns a discriminated result so
 * callers can distinguish a missing file from one that merely could not be read.
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
    try {
      return { status: 'ok', value: JSON.parse(raw) as T }
    } catch (error) {
      return { status: 'parse-error', error }
    }
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
