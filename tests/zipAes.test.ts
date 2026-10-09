import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'crypto'
import { deflateRawSync } from 'zlib'
import { extractZip } from '../src/main/update/zipAes'

/** Same little-endian counter increment the reader uses. */
function incrementCounter(counter: Buffer): void {
  for (let i = 0; i < 16; i++) {
    if (counter[i] === 0xff) counter[i] = 0
    else {
      counter[i]++
      break
    }
  }
}

function aesCtr(key: Buffer, data: Buffer): Buffer {
  const ecb = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  ecb.setAutoPadding(false)
  const out = Buffer.alloc(data.length)
  const counter = Buffer.alloc(16)
  counter[0] = 1
  for (let offset = 0; offset < data.length; offset += 16) {
    const keystream = ecb.update(counter)
    const n = Math.min(16, data.length - offset)
    for (let i = 0; i < n; i++) out[offset + i] = data[offset + i] ^ keystream[i]
    incrementCounter(counter)
  }
  return out
}

interface FixtureEntry {
  name: string
  content: Buffer
  stored?: boolean
}

/** Build a WinZip AE-2 (AES-256) zip, matching what Hypergryph ships. */
function buildAesZip(entries: FixtureEntry[], password: string): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const compressed = entry.stored ? entry.content : deflateRawSync(entry.content)
    const method = entry.stored ? 0 : 8
    const strength = 3
    const salt = randomBytes(strength * 4 + 4)
    const keyLength = strength * 8 + 8
    const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, keyLength * 2 + 2, 'sha1')
    const encKey = derived.subarray(0, keyLength)
    const macKey = derived.subarray(keyLength, keyLength * 2)
    const verify = derived.subarray(keyLength * 2, keyLength * 2 + 2)
    const ciphertext = aesCtr(encKey, compressed)
    const mac = createHmac('sha1', macKey).update(ciphertext).digest().subarray(0, 10)
    const data = Buffer.concat([salt, verify, ciphertext, mac])

    const extra = Buffer.alloc(11)
    extra.writeUInt16LE(0x9901, 0)
    extra.writeUInt16LE(7, 2)
    extra.writeUInt16LE(2, 4) // AE-2
    extra.write('AE', 6, 'ascii')
    extra.writeUInt8(strength, 8)
    extra.writeUInt16LE(method, 9)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(51, 4)
    local.writeUInt16LE(0x0001, 6)
    local.writeUInt16LE(99, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(extra.length, 28)
    locals.push(local, nameBytes, extra, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(51, 4)
    central.writeUInt16LE(51, 6)
    central.writeUInt16LE(0x0001, 8)
    central.writeUInt16LE(99, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.content.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes, extra)

    offset += local.length + nameBytes.length + extra.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const centralOffset = offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

describe('extractZip (WinZip AES)', () => {
  it('decrypts and extracts deflate + stored entries', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-zipaes-'))
    const zipPath = join(dir, 'patch.zip')
    const outDir = join(dir, 'out')
    const text = Buffer.from('KevinLauncher 明日方舟补丁测试 '.repeat(2000))
    const binary = randomBytes(4096)
    await fs.writeFile(
      zipPath,
      buildAesZip(
        [
          { name: 'vfs_files/vfs_patch/diff/x.ab_patch', content: text },
          { name: 'config.ini', content: binary, stored: true }
        ],
        'Rjjf9hAA6N88CwXzGq2T7JooxhleRMRw'
      )
    )

    const progress: number[] = []
    await extractZip({
      zipPath,
      destDir: outDir,
      password: 'Rjjf9hAA6N88CwXzGq2T7JooxhleRMRw',
      onProgress: (done) => progress.push(done)
    })

    expect(await fs.readFile(join(outDir, 'vfs_files', 'vfs_patch', 'diff', 'x.ab_patch'))).toEqual(text)
    expect(await fs.readFile(join(outDir, 'config.ini'))).toEqual(binary)
    expect(progress.at(-1)).toBe(text.length + binary.length)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('rejects a wrong password', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-zipaes-'))
    const zipPath = join(dir, 'patch.zip')
    await fs.writeFile(
      zipPath,
      buildAesZip([{ name: 'a.txt', content: Buffer.from('secret') }], 'correct')
    )
    await expect(
      extractZip({ zipPath, destDir: join(dir, 'out'), password: 'wrong' })
    ).rejects.toThrow()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
