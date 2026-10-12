import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadJsonSafe, quarantineFile, writeFileAtomic } from '../src/main/services/atomicFile'

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-file-'))
  return join(dir, name)
}

describe('writeFileAtomic', () => {
  it('writes and overwrites without leaving a temp file', async () => {
    const file = await tempFile('data.json')
    await writeFileAtomic(file, '{"a":1}')
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}')
    await writeFileAtomic(file, '{"a":2}')
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":2}')
    await expect(fs.access(`${file}.tmp`)).rejects.toBeTruthy()
  })
})

describe('loadJsonSafe', () => {
  it('reports a missing file', async () => {
    const file = await tempFile('none.json')
    expect(await loadJsonSafe(file)).toEqual({ status: 'missing' })
  })

  it('parses a valid file', async () => {
    const file = await tempFile('ok.json')
    await fs.writeFile(file, '{"x":42}')
    const result = await loadJsonSafe<{ x: number }>(file)
    expect(result).toEqual({ status: 'ok', value: { x: 42 } })
  })

  it('reports invalid JSON as a parse error, not as empty', async () => {
    const file = await tempFile('bad.json')
    await fs.writeFile(file, '{ not json')
    expect((await loadJsonSafe(file)).status).toBe('parse-error')
  })

  it('reports an unreadable path as a read error', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-file-'))
    // Reading a directory fails with EISDIR — a stand-in for a locked file.
    expect((await loadJsonSafe(dir)).status).toBe('read-error')
  })
})

describe('quarantineFile', () => {
  it('moves the corrupt file aside', async () => {
    const file = await tempFile('data.json')
    await fs.writeFile(file, 'garbage')
    expect(await quarantineFile(file)).toBe(true)
    expect(await fs.readFile(`${file}.corrupt`, 'utf8')).toBe('garbage')
    await expect(fs.access(file)).rejects.toBeTruthy()
  })
})
