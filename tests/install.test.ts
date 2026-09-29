import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles, staleFiles } from '../src/main/services/install'

describe('staleFiles', () => {
  it('keeps only files that the new version no longer ships', () => {
    expect(staleFiles(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['a'])
  })

  it('never reports install.json (the marker is rewritten, not stale)', () => {
    expect(staleFiles(['install.json', 'old'], ['new'])).toEqual(['old'])
  })

  it('returns nothing when the file set is unchanged', () => {
    expect(staleFiles(['a', 'b'], ['a', 'b'])).toEqual([])
  })
})

describe('listFiles', () => {
  it('lists files recursively with forward slashes, sorted', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'install-test-'))
    await fs.mkdir(join(dir, 'resources', 'app'), { recursive: true })
    await fs.writeFile(join(dir, 'KevinLauncher.exe'), 'x')
    await fs.writeFile(join(dir, 'resources', 'app', 'main.js'), 'y')

    expect(await listFiles(dir)).toEqual(['KevinLauncher.exe', 'resources/app/main.js'])
  })

  it('returns an empty list for a missing directory', async () => {
    await expect(listFiles(join(tmpdir(), 'does-not-exist-' + Date.now()))).rejects.toThrow()
  })
})
