import { app, safeStorage } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

interface TokenFile {
  [key: string]: string
}

/**
 * Persists credentials (e.g. account tokens) encrypted with the OS keychain
 * (DPAPI on Windows via Electron safeStorage). Reused until they expire.
 */
export class TokenStore {
  private cache: TokenFile | null = null

  private file(): string {
    return join(app.getPath('userData'), 'auth.json')
  }

  private async load(): Promise<TokenFile> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await fs.readFile(this.file(), 'utf-8')) as TokenFile
    } catch {
      this.cache = {}
    }
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
    data[key] = safeStorage.encryptString(value).toString('base64')
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(this.file(), JSON.stringify(data), 'utf-8')
  }

  async remove(key: string): Promise<void> {
    const data = await this.load()
    if (!(key in data)) return
    delete data[key]
    await fs.writeFile(this.file(), JSON.stringify(data), 'utf-8')
  }
}
