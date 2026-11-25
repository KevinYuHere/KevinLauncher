import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectAudioLanguages } from '../src/main/update/hoyoplay'

const dirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-audio-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('detectAudioLanguages', () => {
  it('detects voice packs from the AudioAssets folders (no marker files)', async () => {
    const dir = await makeDir()
    const assets = join(dir, 'YuanShen_Data', 'StreamingAssets', 'AudioAssets')
    for (const name of ['Chinese', 'English(US)', 'Japanese']) {
      await fs.mkdir(join(assets, name), { recursive: true })
    }
    expect(await detectAudioLanguages('genshin', dir)).toEqual(['zh-cn', 'en-us', 'ja-jp'])
  })

  it('still honours the legacy marker files', async () => {
    const dir = await makeDir()
    await fs.writeFile(join(dir, 'Audio_Korean_pkg_version'), '[]')
    expect(await detectAudioLanguages('genshin', dir)).toEqual(['ko-kr'])
  })

  it('combines markers and folders without duplicates', async () => {
    const dir = await makeDir()
    const assets = join(dir, 'YuanShen_Data', 'StreamingAssets', 'AudioAssets')
    await fs.mkdir(join(assets, 'Chinese'), { recursive: true })
    await fs.writeFile(join(dir, 'Audio_Chinese_pkg_version'), '[]')
    expect(await detectAudioLanguages('genshin', dir)).toEqual(['zh-cn'])
  })

  it('ignores unrelated folders for other games', async () => {
    const dir = await makeDir()
    await fs.mkdir(join(dir, 'YuanShen_Data', 'StreamingAssets', 'AudioAssets', 'Chinese'), {
      recursive: true
    })
    // A Genshin layout must not be picked up for Star Rail.
    expect(await detectAudioLanguages('starrail', dir)).toEqual([])
  })
})
