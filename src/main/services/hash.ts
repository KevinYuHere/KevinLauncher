import { createHash } from 'crypto'
import { createReadStream } from 'fs'

/** Hex digest of a file, streamed (never loads the whole file into memory). */
export function hashFile(path: string, algorithm: 'md5' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export const md5File = (path: string): Promise<string> => hashFile(path, 'md5')
export const sha256File = (path: string): Promise<string> => hashFile(path, 'sha256')
