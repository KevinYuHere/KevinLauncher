import { loadJsonSafe, quarantineFile } from './atomicFile'
import { log } from './logger'

export interface StoreLoad<T> {
  /** The parsed value, or `empty()` when the file is missing/corrupt. */
  data: T
  /** False when the file could not be read — the caller must not save. */
  writable: boolean
  status: 'ok' | 'missing' | 'parse-error' | 'read-error'
  error?: unknown
}

/**
 * Open a persisted JSON file with the launcher's data-safety rules:
 *
 * - missing file → start from `empty()`, saving allowed;
 * - unparsable file → move it aside as `<file>.corrupt` (recoverable), start
 *   from `empty()`, saving allowed only once the bad file is out of the way;
 * - unreadable file (locked / permission) → start from `empty()` but **refuse
 *   to save**, so a transient failure can never overwrite the real data.
 */
export async function openJsonStore<T>(file: string, empty: () => T, label: string): Promise<StoreLoad<T>> {
  const result = await loadJsonSafe<T>(file)
  if (result.status === 'ok') return { data: result.value, writable: true, status: result.status }
  if (result.status === 'parse-error') {
    const quarantined = await quarantineFile(file)
    log(
      `${label}: file is corrupt (${String(result.error)}) — kept as .corrupt` +
        (quarantined ? '' : ', saving disabled this session')
    )
    return { data: empty(), writable: quarantined, status: result.status, error: result.error }
  }
  if (result.status === 'read-error') {
    log(`${label}: file unreadable (${String(result.error)}) — saving disabled this session`)
    return { data: empty(), writable: false, status: result.status, error: result.error }
  }
  return { data: empty(), writable: true, status: result.status }
}
