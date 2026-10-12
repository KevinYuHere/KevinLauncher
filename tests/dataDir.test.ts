import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedDataDir } from '../src/main/services/dataDir'

async function makeDir(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix))
}

describe('seedDataDir', () => {
  it('seeds an empty target from the default directory', async () => {
    const root = await makeDir('kl-seed-')
    const fallback = join(root, 'default')
    const target = join(root, 'custom')
    await fs.mkdir(fallback, { recursive: true })
    await fs.writeFile(join(fallback, 'config.json'), '{"apps":[]}')
    await fs.writeFile(join(fallback, 'playtime.json'), '{"sessions":[]}')

    const result = await seedDataDir(target, fallback)
    expect(result.copied).toBeGreaterThan(0)
    expect(result.keptExisting).toBe(false)
    expect(await fs.readFile(join(target, 'playtime.json'), 'utf8')).toBe('{"sessions":[]}')
    // The old directory is removed once the copy succeeded.
    await expect(fs.access(fallback)).rejects.toBeTruthy()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('never overwrites a target that already holds data', async () => {
    const root = await makeDir('kl-seed-')
    const fallback = join(root, 'default')
    const target = join(root, 'custom')
    await fs.mkdir(fallback, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(join(fallback, 'config.json'), '{"apps":[]}')
    await fs.writeFile(join(fallback, 'playtime.json'), '{"sessions":["old"]}')
    await fs.writeFile(join(target, 'config.json'), '{"apps":["x"]}')
    await fs.writeFile(join(target, 'playtime.json'), '{"sessions":["new"]}')

    const result = await seedDataDir(target, fallback)
    expect(result.keptExisting).toBe(true)
    expect(result.copied).toBe(0)
    // The newer target data survives, the default directory is left alone.
    expect(await fs.readFile(join(target, 'playtime.json'), 'utf8')).toBe('{"sessions":["new"]}')
    expect(await fs.readFile(join(fallback, 'playtime.json'), 'utf8')).toBe('{"sessions":["old"]}')
    await fs.rm(root, { recursive: true, force: true })
  })
})
