import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadJsonSafe, parseJsonLenient, writeFileAtomic } from '../src/main/services/atomicFile'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'kl-atomic-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('never interleaves concurrent writes (the file is exactly one payload)', async () => {
    const file = join(dir, 'config.json')
    // Vary the length so a torn write would leave the longer payload's tail.
    const payloads = Array.from({ length: 64 }, (_, i) =>
      JSON.stringify({ version: 1, apps: [], pad: 'x'.repeat(i % 9) }, null, 2)
    )
    await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload)))
    const raw = await fs.readFile(file, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(payloads).toContain(raw)
    // No stray temp files left behind.
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('parseJsonLenient', () => {
  it('parses ordinary JSON', () => {
    expect(parseJsonLenient<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('recovers the root value when trailing junk follows (1.2.2 corruption)', () => {
    const raw = '{\n  "version": 14,\n  "apps": []\n}\n}\n}'
    expect(parseJsonLenient<{ version: number }>(raw)).toEqual({ version: 14, apps: [] })
  })

  it('keeps braces inside strings intact', () => {
    const raw = '{"name":"a}b{c","apps":[]}}\n'
    expect(parseJsonLenient<{ name: string }>(raw)).toEqual({ name: 'a}b{c', apps: [] })
  })

  it('recovers an array root', () => {
    expect(parseJsonLenient<number[]>('[1,2,3] extra')).toEqual([1, 2, 3])
  })

  it('returns undefined for truncated or non-JSON content', () => {
    expect(parseJsonLenient('{"a":1')).toBeUndefined()
    expect(parseJsonLenient('not json at all')).toBeUndefined()
    expect(parseJsonLenient('')).toBeUndefined()
  })
})

describe('loadJsonSafe', () => {
  it('self-heals a file with trailing junk instead of reporting it corrupt', async () => {
    const file = join(dir, 'config.json')
    await fs.writeFile(file, '{"version": 14, "apps": [{"id":"a"}]}\n}\n}')
    const result = await loadJsonSafe<{ version: number; apps: { id: string }[] }>(file)
    expect(result).toEqual({ status: 'ok', value: { version: 14, apps: [{ id: 'a' }] } })
  })

  it('still reports genuinely truncated files as parse errors', async () => {
    const file = join(dir, 'config.json')
    await fs.writeFile(file, '{"version": 14, "apps": [')
    const result = await loadJsonSafe(file)
    expect(result.status).toBe('parse-error')
  })
})
