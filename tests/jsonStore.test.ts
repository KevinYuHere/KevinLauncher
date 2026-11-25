import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openJsonStore } from '../src/main/services/jsonStore'

async function tempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'kl-jsons-'))
}

interface Doc {
  version: number
  items: string[]
}
const empty = (): Doc => ({ version: 1, items: [] })

describe('openJsonStore', () => {
  it('starts empty (and writable) when the file is missing', async () => {
    const file = join(await tempDir(), 'doc.json')
    expect(await openJsonStore(file, empty, 'test')).toEqual({ data: empty(), writable: true })
  })

  it('returns the parsed value', async () => {
    const file = join(await tempDir(), 'doc.json')
    await fs.writeFile(file, '{"version":1,"items":["a"]}')
    expect(await openJsonStore<Doc>(file, empty, 'test')).toEqual({
      data: { version: 1, items: ['a'] },
      writable: true
    })
  })

  it('quarantines corrupt JSON and stays writable', async () => {
    const file = join(await tempDir(), 'doc.json')
    await fs.writeFile(file, '{not json')
    const result = await openJsonStore<Doc>(file, empty, 'test')
    expect(result).toEqual({ data: empty(), writable: true })
    expect(await fs.readFile(`${file}.corrupt`, 'utf8')).toBe('{not json')
  })

  it('refuses to save when the file cannot be read', async () => {
    const dir = await tempDir()
    // Reading a directory fails with EISDIR — a stand-in for a locked file.
    const result = await openJsonStore<Doc>(dir, empty, 'test')
    expect(result.data).toEqual(empty())
    expect(result.writable).toBe(false)
  })
})
