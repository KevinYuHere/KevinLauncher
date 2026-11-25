import { app, safeStorage } from 'electron'
import { join } from 'path'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'
import { isObject } from './configValidation'

interface TokenFile {
  [key: string]: string
}

let queue = Promise.resolve()

/**
 * Persists credentials (e.g. account tokens) encrypted with the OS keychain
 * (DPAPI on Windows via Electron safeStorage). Reused until they expire.
 */
export class TokenStore {
  private file(): string {
    return join(app.getPath('userData'), 'auth.json')
  }

  private access<T>(operation: (data: TokenFile, save: () => Promise<void>) => T | Promise<T>): Promise<T> {
    const file = this.file()
    const task = queue.then(async () => {
      if (this.file() !== file) throw new Error('数据目录已切换')
      const { data, writable, error } = await openJsonStore<unknown>(file, () => ({}), 'tokens')
      if (!writable) throw new Error('凭据读取失败，已暂停写入', { cause: error })
      if (!isObject(data) || Object.values(data).some((value) => typeof value !== 'string')) {
        throw new Error('凭据文件格式无效')
      }
      const tokens = data as TokenFile
      return operation(tokens, async () => {
        if (this.file() !== file) throw new Error('数据目录已切换')
        try {
          await writeFileAtomic(file, JSON.stringify(tokens))
        } catch (cause) {
          throw new Error('保存凭据失败', { cause })
        }
      })
    })
    queue = task.then(() => undefined, () => undefined)
    return task
  }

  get(key: string): Promise<string | null> {
    return this.access((data) => Object.hasOwn(data, key) ? decrypt(data[key]) : null)
  }

  set(key: string, value: string): Promise<void> {
    return this.access(async (data, save) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密服务不可用')
      const encrypted = safeStorage.encryptString(value).toString('base64')
      Object.defineProperty(data, key, { value: encrypted, enumerable: true, writable: true, configurable: true })
      await save()
    })
  }

  remove(key: string, expected?: string): Promise<void> {
    return this.access(async (data, save) => {
      if (!Object.hasOwn(data, key) || (expected !== undefined && decrypt(data[key]) !== expected)) return
      delete data[key]
      await save()
    })
  }
}

function decrypt(encrypted: string): string | null {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      : null
  } catch {
    return null
  }
}
