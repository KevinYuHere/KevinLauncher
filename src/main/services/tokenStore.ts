import { app, safeStorage } from 'electron'
import { join } from 'path'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'

interface TokenFile {
  [key: string]: string
}

/**
 * Persists credentials (e.g. account tokens) encrypted with the OS keychain
 * (DPAPI on Windows via Electron safeStorage). Reused until they expire.
 */
export class TokenStore {
  private cache: TokenFile | null = null
  /** Set when the store file could not be read — writes are refused. */
  private saveBlocked = false

  private file(): string {
    return join(app.getPath('userData'), 'auth.json')
  }

  private async load(): Promise<TokenFile> {
    if (this.cache) return this.cache
    const { data, writable } = await openJsonStore<TokenFile>(this.file(), () => ({}), 'tokens')
    this.cache = data && typeof data === 'object' ? data : {}
    this.saveBlocked = !writable
    return this.cache
  }

  async get(key: string): Promise<string | null> {
    const data = await this.load()
    const encrypted = data[key]
    if (!encrypted) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return
    const data = await this.load()
    if (this.saveBlocked) return
    data[key] = safeStorage.encryptString(value).toString('base64')
    await writeFileAtomic(this.file(), JSON.stringify(data)).catch(() => undefined)
  }

  async remove(key: string): Promise<void> {
    const data = await this.load()
    if (this.saveBlocked || !(key in data)) return
    delete data[key]
    await writeFileAtomic(this.file(), JSON.stringify(data)).catch(() => undefined)
  }
}
