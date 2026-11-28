import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import {
  discoveredGameToNewApp,
  isGameDiscoveryCandidateAlreadyAdded,
  normalizeGamePath
} from '@shared/gameDiscovery'
import { discoverGames, resolveLocalGamePath } from '../src/main/services/gameDiscovery'
import { parseGameRegistryCandidates } from '../src/main/services/gameRegistry'

const roots: string[] = []
const ISO = '2026-11-26T08:00:00.000Z'

async function file(path: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, '')
}

async function dir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

async function makeGame(
  base: string,
  relative: string[],
  executable: string,
  marker: string
): Promise<string> {
  const directory = join(base, ...relative)
  await dir(directory)
  await file(join(directory, executable))
  await dir(join(directory, marker))
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('local game discovery', () => {
  it('finds four games, de-duplicates paths and marks existing apps', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'kl-game-discovery-'))
    roots.push(base)
    const programFiles = join(base, 'Program Files')
    const genshin = await makeGame(
      programFiles,
      ['Genshin Impact', 'Genshin Impact Game'],
      'YuanShen.exe',
      'YuanShen_Data'
    )
    const starrail = await makeGame(
      programFiles,
      ['Star Rail', 'Game'],
      'StarRail.exe',
      'StarRail_Data'
    )
    const zzz = await makeGame(
      programFiles,
      ['ZenlessZoneZero Game'],
      'ZenlessZoneZero.exe',
      'ZenlessZoneZero_Data'
    )
    const arknights = await makeGame(
      programFiles,
      ['Arknights', 'Arknights Game'],
      'Arknights.exe',
      'Arknights_Data'
    )
    const badRoot = join(base, 'bad')
    await dir(badRoot)
    await file(join(badRoot, 'YuanShen.exe'))
    const missingExecutable = join(base, 'marker-only')
    await dir(join(missingExecutable, 'YuanShen_Data'))

    const result = await discoverGames({
      environment: { ProgramFiles: programFiles },
      now: () => new Date(ISO),
      existingApps: [{ gameDirectory: arknights, launchMethods: [] }],
      registry: {
        readCandidates: async () => [
          { game: 'starrail', path: join(programFiles, 'Star Rail') },
          { game: 'zzz', path: zzz },
          { game: 'arknights', path: join(programFiles, 'Arknights') },
          { game: 'genshin', path: badRoot },
          { game: 'genshin', path: missingExecutable },
          { game: 'genshin', path: parse(programFiles).root },
          { game: 'genshin', path: '\\\\server\\share\\game' },
          { game: 'genshin', path: join(base, 'missing') }
        ]
      }
    })

    expect(result.scannedAt).toBe(ISO)
    expect(result.warnings).toEqual([])
    expect(result.candidates.map((candidate) => candidate.game)).toEqual([
      'genshin',
      'starrail',
      'zzz',
      'arknights'
    ])
    expect(result.candidates.map((candidate) => candidate.installDirectory)).toEqual([
      genshin,
      starrail,
      zzz,
      arknights
    ])
    expect(result.candidates.map((candidate) => candidate.source)).toEqual([
      'common-path',
      'registry',
      'registry',
      'registry'
    ])
    expect(result.candidates.find((candidate) => candidate.game === 'arknights')?.alreadyAdded).toBe(true)
    expect(new Set(result.candidates.map((candidate) => normalizeGamePath(candidate.installDirectory))).size).toBe(4)
    for (const candidate of result.candidates) {
      expect(candidate).not.toHaveProperty('canUpdate')
      expect(candidate.marker).toContain('_Data')
      expect(candidate.executablePath.startsWith(candidate.installDirectory)).toBe(true)
    }
  })

  it('keeps common-path results when the registry cannot be read', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'kl-game-fallback-'))
    roots.push(base)
    const programFiles = join(base, 'Program Files')
    const zzz = await makeGame(
      programFiles,
      ['Zenless Zone Zero'],
      'ZenlessZoneZero.exe',
      'ZenlessZoneZero_Data'
    )
    const result = await discoverGames({
      environment: { ProgramFiles: programFiles },
      now: () => new Date(ISO),
      registry: {
        readCandidates: async () => {
          throw new Error('access denied')
        }
      }
    })
    expect(result.warnings).toEqual(['无法读取本机游戏登记，已仅检查常见安装路径'])
    expect(result.candidates).toEqual([
      expect.objectContaining({ game: 'zzz', installDirectory: zzz, source: 'common-path' })
    ])
  })

  it('rejects unsafe paths and malformed registry rows as data', () => {
    const root = parse(resolveLocalGamePath(process.cwd()) ?? process.cwd()).root
    expect(resolveLocalGamePath('')).toBeNull()
    expect(resolveLocalGamePath('relative\\game')).toBeNull()
    expect(resolveLocalGamePath(root)).toBeNull()
    expect(resolveLocalGamePath('\\\\server\\share')).toBeNull()
    expect(resolveLocalGamePath('C:\\game?path')).toBeNull()

    const parsed = parseGameRegistryCandidates(
      JSON.stringify([
        { game: 'genshin', path: 'C:\\Games\\原神' },
        { game: 'unknown', path: 'C:\\Games\\x' },
        { game: 'zzz', path: 42 },
        { game: 'zzz', path: '   ' },
        { game: 'genshin', path: 'C:\\Games\\原神' }
      ])
    )
    expect(parsed).toEqual([{ game: 'genshin', path: 'C:\\Games\\原神' }])
    expect(() => parseGameRegistryCandidates('{bad')).toThrow('格式无效')
  })

  it('builds the existing app-add payload and duplicate check only from verified data', () => {
    const candidate = {
      game: 'genshin' as const,
      name: '原神',
      installDirectory: 'C:\\Games\\Genshin Impact\\Genshin Impact Game',
      executablePath: 'C:\\Games\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe',
      executableName: 'YuanShen.exe',
      marker: 'YuanShen_Data',
      source: 'registry' as const,
      alreadyAdded: false
    }
    expect(discoveredGameToNewApp(candidate)).toEqual({
      name: '原神',
      addonId: 'genshin',
      gameDirectory: candidate.installDirectory,
      launchMethods: [
        {
          targetPath: candidate.executablePath,
          arguments: '',
          workingDirectory: candidate.installDirectory,
          runAsAdmin: true
        }
      ],
      monitorProcessNames: ['YuanShen.exe']
    })
    expect(isGameDiscoveryCandidateAlreadyAdded(candidate, [])).toBe(false)
    expect(
      isGameDiscoveryCandidateAlreadyAdded(candidate, [
        { gameDirectory: candidate.installDirectory, launchMethods: [] }
      ])
    ).toBe(true)
    expect(
      isGameDiscoveryCandidateAlreadyAdded(candidate, [
        { launchMethods: [{ targetPath: candidate.executablePath.toUpperCase() }] }
      ])
    ).toBe(true)
  })
})
