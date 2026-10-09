import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { join, dirname, relative, isAbsolute } from 'path'
import { createCipheriv, createHmac, pbkdf2Sync, type Hmac } from 'crypto'
import { Transform, PassThrough } from 'stream'
import { pipeline } from 'stream/promises'
import { createInflateRaw } from 'zlib'

/**
 * Minimal reader for the AES-encrypted (WinZip / PKWARE "AE-2") ZIP archives
 * Hypergryph ships as game patches. Windows' `bsdtar` and Node's built-in zip
 * helpers cannot open these, and bundling another unzip binary would not be
 * carried over by the launcher's code-only in-app updates — so the format is
 * decoded here directly.
 *
 * Only the features the Arknights patch archives use are supported: stored /
 * deflate entries, AES-256 (any strength) or unencrypted, no ZIP64.
 */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const AES_EXTRA_ID = 0x9901

interface ZipEntry {
  name: string
  /** Real compression method (the AES extra field hides the `99` marker). */
  method: number
  encrypted: boolean
  /** AES strength: 0 = not encrypted, otherwise 1/2/3 (128/192/256). */
  aesStrength: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** Increment a 16-byte little-endian counter in place (WinZip AES CTR). */
function incrementCounter(counter: Buffer): void {
  for (let i = 0; i < 16; i++) {
    if (counter[i] === 0xff) counter[i] = 0
    else {
      counter[i]++
      break
    }
  }
}

/**
 * Stream transform that decrypts WinZip AES data: AES-CTR where the counter is
 * a little-endian 128-bit value starting at 1. Node's `aes-*-ctr` increments
 * the counter big-endian, so the keystream is produced block by block here.
 * The ciphertext is fed into `hmac` for the trailing authentication check.
 */
class AesCtrDecryptor extends Transform {
  private readonly ecb: ReturnType<typeof createCipheriv>
  private readonly hmac: Hmac
  private readonly counter = Buffer.alloc(16)
  private pending: Buffer = Buffer.alloc(0)

  constructor(key: Buffer, hmac: Hmac) {
    super()
    this.ecb = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
    this.ecb.setAutoPadding(false)
    this.counter[0] = 1
    this.hmac = hmac
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.hmac.update(chunk)
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const full = data.length - (data.length % 16)
    if (full > 0) {
      // Encrypt all counter blocks in one native call, then XOR.
      const blocks = full / 16
      const counters = Buffer.allocUnsafe(full)
      for (let b = 0; b < blocks; b++) {
        this.counter.copy(counters, b * 16)
        incrementCounter(this.counter)
      }
      const keystream = this.ecb.update(counters)
      const out = Buffer.allocUnsafe(full)
      for (let i = 0; i < full; i++) out[i] = data[i] ^ keystream[i]
      this.push(out)
    }
    this.pending = Buffer.from(data.subarray(full))
    callback()
  }

  override _flush(callback: () => void): void {
    if (this.pending.length > 0) {
      const keystream = this.ecb.update(this.counter)
      const out = Buffer.allocUnsafe(this.pending.length)
      for (let i = 0; i < this.pending.length; i++) out[i] = this.pending[i] ^ keystream[i]
      this.push(out)
      this.pending = Buffer.alloc(0)
    }
    callback()
  }
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>

/** Read `length` bytes at `position` from an open file handle. */
async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  await handle.read(buffer, 0, length, position)
  return buffer
}

/** Parse the central directory of an (already merged) zip file. */
async function readEntries(path: string): Promise<ZipEntry[]> {
  const handle = await fs.open(path, 'r')
  try {
    const { size } = await handle.stat()
    const tailLength = Math.min(size, 66_000)
    const tail = await readAt(handle, tailLength, size - tailLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('游戏补丁包格式异常（未找到 ZIP 目录）')
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    const central = await readAt(handle, centralSize, centralOffset)

    const entries: ZipEntry[] = []
    let pos = 0
    while (pos + 46 <= central.length && central.readUInt32LE(pos) === CENTRAL_SIG) {
      const flags = central.readUInt16LE(pos + 8)
      const method = central.readUInt16LE(pos + 10)
      const compressedSize = central.readUInt32LE(pos + 20)
      const uncompressedSize = central.readUInt32LE(pos + 24)
      const nameLength = central.readUInt16LE(pos + 28)
      const extraLength = central.readUInt16LE(pos + 30)
      const commentLength = central.readUInt16LE(pos + 32)
      const localHeaderOffset = central.readUInt32LE(pos + 42)
      const name = central.toString('utf8', pos + 46, pos + 46 + nameLength)
      const extra = central.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength)

      let aesStrength = 0
      let realMethod = method
      for (let i = 0; i + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(i)
        const len = extra.readUInt16LE(i + 2)
        if (id === AES_EXTRA_ID) {
          aesStrength = extra[i + 8]
          realMethod = extra.readUInt16LE(i + 9)
        }
        i += 4 + len
      }

      entries.push({
        name,
        method: realMethod,
        encrypted: (flags & 1) !== 0,
        aesStrength,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      })
      pos += 46 + nameLength + extraLength + commentLength
    }
    return entries
  } finally {
    await handle.close()
  }
}

/** Resolve an archive entry name inside `base`, rejecting path traversal. */
function safeJoin(base: string, name: string): string {
  const full = join(base, ...name.split('/'))
  const rel = relative(base, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`补丁包含非法路径：${name}`)
  return full
}

export interface ExtractOptions {
  zipPath: string
  destDir: string
  password?: string
  signal?: AbortSignal
  /** Called with cumulative extracted (uncompressed) bytes and the total. */
  onProgress?: (extracted: number, total: number) => void
}

/**
 * Extract every file of an AES/plain zip into `destDir`. Entries are streamed
 * so the whole archive never has to be held in memory.
 */
export async function extractZip(options: ExtractOptions): Promise<void> {
  const entries = await readEntries(options.zipPath)
  const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  let extracted = 0

  const handle = await fs.open(options.zipPath, 'r')
  try {
    for (const entry of entries) {
      if (options.signal?.aborted) throw new Error('已取消')
      if (entry.name.endsWith('/')) {
        await fs.mkdir(safeJoin(options.destDir, entry.name), { recursive: true })
        continue
      }
      const dest = safeJoin(options.destDir, entry.name)
      if (entry.uncompressedSize === 0) {
        await fs.mkdir(dirname(dest), { recursive: true })
        await fs.writeFile(dest, Buffer.alloc(0))
        continue
      }
      await fs.mkdir(dirname(dest), { recursive: true })

      // Local header: skip the name + extra fields to reach the file data.
      const header = await readAt(handle, 30, entry.localHeaderOffset)
      const nameLength = header.readUInt16LE(26)
      const extraLength = header.readUInt16LE(28)
      const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength

      if (!entry.encrypted || entry.aesStrength === 0) {
        const start = dataStart
        const end = dataStart + entry.compressedSize - 1
        const source = createReadStream(options.zipPath, { start, end })
        await pipeEntry(source, entry, dest)
      } else {
        if (!options.password) throw new Error('缺少补丁解密口令')
        // Strength 1/2/3 maps to AES-128/192/256 → 8/12/16-byte salts and
        // 16/24/32-byte keys.
        const saltLength = entry.aesStrength * 4 + 4
        const keyLength = entry.aesStrength * 8 + 8
        const salt = await readAt(handle, saltLength, dataStart)
        const verify = await readAt(handle, 2, dataStart + saltLength)
        const encryptedLength = entry.compressedSize - saltLength - 2 - 10
        const encryptedStart = dataStart + saltLength + 2
        const storedMac = await readAt(handle, 10, encryptedStart + encryptedLength)

        const derived = pbkdf2Sync(Buffer.from(options.password, 'utf8'), salt, 1000, keyLength * 2 + 2, 'sha1')
        const encKey = derived.subarray(0, keyLength)
        const macKey = derived.subarray(keyLength, keyLength * 2)
        if (!verify.equals(derived.subarray(keyLength * 2, keyLength * 2 + 2))) {
          throw new Error('补丁解密失败（口令不匹配）')
        }

        const hmac = createHmac('sha1', macKey)
        const source = createReadStream(options.zipPath, {
          start: encryptedStart,
          end: encryptedStart + encryptedLength - 1
        })
        await pipeEntry(source, entry, dest, new AesCtrDecryptor(encKey, hmac), () => {
          const mac = hmac.digest().subarray(0, 10)
          if (!mac.equals(storedMac)) throw new Error(`补丁校验失败：${entry.name}`)
        })
      }

      extracted += entry.uncompressedSize
      options.onProgress?.(extracted, total)
    }
  } finally {
    await handle.close()
  }
}

/** Pipe a (possibly encrypted) entry through the right decompressor. */
async function pipeEntry(
  source: NodeJS.ReadableStream,
  entry: ZipEntry,
  dest: string,
  transform?: Transform,
  verify?: () => void
): Promise<void> {
  const decompressor = entry.method === 8 ? createInflateRaw() : new PassThrough()
  if (transform) await pipeline(source, transform, decompressor, createWriteStream(dest))
  else await pipeline(source, decompressor, createWriteStream(dest))
  verify?.()
}
