import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import {
  applyVfsManifest,
  commitStage,
  installConfig,
  processDeleteList,
  stageStaticFiles,
  type PatchManifest
} from '../src/main/update/arknightsPatch'

const md5 = (data: string): string => createHash('md5').update(data).digest('hex')

async function makeDirs(): Promise<{ root: string; gameDir: string; extractDir: string; stageDir: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-akpatch-'))
  const gameDir = join(root, 'game')
  const extractDir = join(root, 'extract')
  const stageDir = join(root, 'stage')
  const vfs = 'Arknights_Data/StreamingAssets/AB/Windows'
  await fs.mkdir(join(gameDir, ...vfs.split('/')), { recursive: true })
  await fs.mkdir(extractDir, { recursive: true })
  await fs.mkdir(stageDir, { recursive: true })
  return { root, gameDir, extractDir, stageDir }
}

describe('arknights delta patch', () => {
  it('stages, patches, commits and applies the delete list', async () => {
    const { root, gameDir, extractDir, stageDir } = await makeDirs()
    const vfs = 'Arknights_Data/StreamingAssets/AB/Windows'

    // Existing base file in the game + a legacy file to be deleted.
    await fs.writeFile(join(gameDir, ...vfs.split('/'), 'a.ab'), 'BASE')
    await fs.writeFile(join(gameDir, 'old.bin'), 'old')

    // Extracted patch archive.
    await fs.mkdir(join(extractDir, 'vfs_files', 'vfs_patch', 'diff_78.0.0_77.0.0'), {
      recursive: true
    })
    await fs.writeFile(
      join(extractDir, 'vfs_files', 'vfs_patch', 'diff_78.0.0_77.0.0', 'a.ab_patch'),
      'DIFF'
    )
    await fs.mkdir(join(extractDir, 'vfs_files', 'files', ...vfs.split('/')), { recursive: true })
    await fs.writeFile(join(extractDir, 'vfs_files', 'files', ...vfs.split('/'), 'new.ab'), 'NEW')
    await fs.writeFile(join(extractDir, 'Arknights.exe'), 'EXE')
    const newConfig = 'VERSION78'
    await fs.writeFile(join(extractDir, 'config.ini'), newConfig)
    await fs.writeFile(join(extractDir, 'patch.json'), '{}')
    await fs.writeFile(join(extractDir, 'delete_files.txt'), 'old.bin\n')

    const manifest: PatchManifest = {
      version: '78.0.0',
      vfs_base_path: vfs,
      files: [
        {
          name: 'a.ab',
          md5: md5('PATCHED'),
          size: 7,
          patch: [{ base_file: 'a.ab', base_md5: md5('BASE'), patch: 'diff_78.0.0_77.0.0/a.ab_patch' }]
        },
        {
          name: 'new.ab',
          md5: md5('NEW'),
          size: 3,
          local_path: `vfs_files/files/${vfs}/new.ab`
        }
      ]
    }

    await stageStaticFiles(extractDir, stageDir)
    await applyVfsManifest({
      extractDir,
      gameDir,
      stageDir,
      manifest,
      applyPatch: async (_base, _diff, out) => fs.writeFile(out, 'PATCHED')
    })
    // Still untouched on disk until the commit.
    expect(await fs.readFile(join(gameDir, ...vfs.split('/'), 'a.ab'), 'utf8')).toBe('BASE')

    await commitStage(stageDir, gameDir)
    await processDeleteList(extractDir, gameDir, stageDir)
    await installConfig(extractDir, gameDir)

    expect(await fs.readFile(join(gameDir, ...vfs.split('/'), 'a.ab'), 'utf8')).toBe('PATCHED')
    expect(await fs.readFile(join(gameDir, ...vfs.split('/'), 'new.ab'), 'utf8')).toBe('NEW')
    expect(await fs.readFile(join(gameDir, 'Arknights.exe'), 'utf8')).toBe('EXE')
    expect(await fs.readFile(join(gameDir, 'config.ini'), 'utf8')).toBe(newConfig)
    await expect(fs.access(join(gameDir, 'old.bin'))).rejects.toBeTruthy()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the game untouched when a base file is missing', async () => {
    const { root, gameDir, extractDir, stageDir } = await makeDirs()
    const manifest: PatchManifest = {
      vfs_base_path: 'Arknights_Data/StreamingAssets/AB/Windows',
      files: [
        {
          name: 'missing.ab',
          size: 1,
          patch: [
            { base_file: 'missing.ab', base_md5: md5('x'), patch: 'diff/x.ab_patch' }
          ]
        }
      ]
    }
    await expect(
      applyVfsManifest({
        extractDir,
        gameDir,
        stageDir,
        manifest,
        applyPatch: async () => undefined
      })
    ).rejects.toThrow()
    // Nothing was written to the game directory.
    expect(await fs.readdir(join(gameDir, 'Arknights_Data', 'StreamingAssets', 'AB', 'Windows'))).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })
})
