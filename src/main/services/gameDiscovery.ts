import { promises as fs } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { AddonId } from '@shared/types'
import {
  isGameDiscoveryCandidateAlreadyAdded,
  normalizeGamePath,
  type GameDiscoveryCandidate,
  type GameDiscoveryExistingApp,
  type GameDiscoveryResult,
  type GameDiscoverySource
} from '@shared/gameDiscovery'
import { isFileSystemRoot } from './directoryPath'
import { readGameRegistryCandidates, type RegistryGameCandidate } from './gameRegistry'

interface GameSpec {
  id: AddonId
  name: string
  executables: readonly string[]
  /** The `_Data` directories are the known install markers for these clients. */
  markers: readonly string[]
  /** Fixed, short folders under Program Files (never a disk-wide search). */
  commonBases: readonly (readonly string[])[]
  /** Fixed sub-folders that some installers use under the selected root. */
  subdirectories: readonly (readonly string[])[]
}

const GAME_SPECS: readonly GameSpec[] = [
  {
    id: 'genshin',
    name: '原神',
    executables: ['YuanShen.exe'],
    markers: ['YuanShen_Data'],
    commonBases: [['Genshin Impact'], ['原神']],
    subdirectories: [[], ['Genshin Impact Game']]
  },
  {
    id: 'starrail',
    name: '崩坏：星穹铁道',
    executables: ['StarRail.exe'],
    markers: ['StarRail_Data'],
    commonBases: [['Star Rail'], ['崩坏：星穹铁道']],
    subdirectories: [[], ['Game'], ['StarRailGame']]
  },
  {
    id: 'zzz',
    name: '绝区零',
    executables: ['ZenlessZoneZero.exe'],
    markers: ['ZenlessZoneZero_Data'],
    commonBases: [['ZenlessZoneZero Game'], ['Zenless Zone Zero'], ['绝区零']],
    subdirectories: [[], ['Game']]
  },
  {
    id: 'arknights',
    name: '明日方舟',
    executables: ['Arknights.exe'],
    markers: ['Arknights_Data'],
    commonBases: [['Arknights'], ['明日方舟'], ['Hypergryph', 'Arknights']],
    subdirectories: [[], ['Arknights Game']]
  }
]

const MAX_CANDIDATES = 32

export interface GameRegistryReader {
  readCandidates(): Promise<readonly RegistryGameCandidate[]>
}

export interface GameDiscoveryOptions {
  /** Current app list, used only to mark/avoid duplicates. */
  existingApps?: readonly GameDiscoveryExistingApp[]
  registry?: GameRegistryReader
  /** Usually `process.env`; injectable so tests never touch the real user disk. */
  environment?: NodeJS.ProcessEnv
  now?: () => Date
}

const defaultRegistry: GameRegistryReader = {
  readCandidates: readGameRegistryCandidates
}

/**
 * Validate a path from the registry or a common-location list. Only an
 * absolute, local, non-root directory is accepted. UNC/device paths are
 * rejected so a scan cannot leave this machine or open a device namespace.
 */
export function resolveLocalGamePath(raw: string): string | null {
  let value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim()
  }
  if (!value || value.length > 32_767 || value.includes('\0')) return null
  if (/^[\\/]{2}/.test(value)) return null
  if (/[*?"<>|]/.test(value)) return null
  if (!isAbsolute(value)) return null
  const resolved = resolve(value)
  if (isFileSystemRoot(resolved)) return null
  return resolved
}

async function statSafe(path: string) {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

async function inspectDirectory(
  spec: GameSpec,
  rawDirectory: string
): Promise<{ directory: string; executableName: string; marker: string } | null> {
  const directory = resolveLocalGamePath(rawDirectory)
  if (!directory || !(await statSafe(directory))?.isDirectory()) return null

  let executableName: string | undefined
  for (const name of spec.executables) {
    if ((await statSafe(join(directory, name)))?.isFile()) {
      executableName = name
      break
    }
  }
  if (!executableName) return null

  let marker: string | undefined
  for (const name of spec.markers) {
    if (await statSafe(join(directory, name))) {
      marker = name
      break
    }
  }
  if (!marker) return null
  return { directory, executableName, marker }
}

/** Inspect a root and only its fixed, known sub-folders. */
async function inspectRoot(spec: GameSpec, rawRoot: string) {
  const root = resolveLocalGamePath(rawRoot)
  if (!root) return null
  const directories = [root, ...spec.subdirectories.map((parts) => (parts.length ? join(root, ...parts) : root))]
  for (const directory of new Set(directories)) {
    const found = await inspectDirectory(spec, directory)
    if (found) return found
  }
  return null
}

function commonRoots(spec: GameSpec, environment: NodeJS.ProcessEnv): string[] {
  const programRoots = [
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.ProgramW6432
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const roots = new Set<string>()
  for (const programRoot of programRoots) {
    const base = resolveLocalGamePath(programRoot)
    if (!base) continue
    for (const parts of spec.commonBases) {
      const candidate = join(base, ...parts)
      const resolved = resolveLocalGamePath(candidate)
      if (resolved) roots.add(resolved)
    }
  }
  return [...roots]
}

function toCandidate(
  spec: GameSpec,
  found: { directory: string; executableName: string; marker: string },
  source: GameDiscoverySource,
  existingApps: readonly GameDiscoveryExistingApp[]
): GameDiscoveryCandidate {
  const executablePath = join(found.directory, found.executableName)
  const base = {
    game: spec.id,
    name: spec.name,
    installDirectory: found.directory,
    executablePath,
    executableName: found.executableName,
    marker: found.marker,
    source
  }
  return {
    ...base,
    alreadyAdded: isGameDiscoveryCandidateAlreadyAdded(base, existingApps)
  }
}

/**
 * User-triggered scan of four known clients.
 *
 * Only fixed registry keys / uninstall entries and a few Program Files folders
 * are read. Paths are never executed; each candidate must contain the expected
 * executable **and** a known `<Game>_Data` marker. Results are de-duplicated and
 * annotate existing apps so the confirmation UI cannot create duplicates.
 */
export async function discoverGames(options: GameDiscoveryOptions = {}): Promise<GameDiscoveryResult> {
  const existingApps = options.existingApps ?? []
  const registry = options.registry ?? defaultRegistry
  const environment = options.environment ?? process.env
  const now = options.now ?? (() => new Date())

  const warnings: string[] = []
  let registryRows: readonly RegistryGameCandidate[] = []
  try {
    const loaded = await registry.readCandidates()
    registryRows = Array.isArray(loaded) ? loaded : []
  } catch {
    warnings.push('无法读取本机游戏登记，已仅检查常见安装路径')
  }

  const rowsByGame = new Map<AddonId, RegistryGameCandidate[]>()
  for (const row of registryRows) {
    if (!row || typeof row.game !== 'string' || typeof row.path !== 'string') continue
    const rows = rowsByGame.get(row.game) ?? []
    rows.push(row)
    rowsByGame.set(row.game, rows)
  }

  const candidates: GameDiscoveryCandidate[] = []
  const seen = new Set<string>()
  const add = (candidate: GameDiscoveryCandidate): boolean => {
    const key = `${candidate.game}\0${normalizeGamePath(candidate.installDirectory)}`
    if (seen.has(key) || candidates.length >= MAX_CANDIDATES) return false
    seen.add(key)
    candidates.push(candidate)
    return true
  }

  for (const spec of GAME_SPECS) {
    for (const row of rowsByGame.get(spec.id) ?? []) {
      const found = await inspectRoot(spec, row.path)
      if (found) add(toCandidate(spec, found, 'registry', existingApps))
    }
    for (const root of commonRoots(spec, environment)) {
      const found = await inspectRoot(spec, root)
      if (found) add(toCandidate(spec, found, 'common-path', existingApps))
    }
  }

  return {
    candidates,
    warnings,
    scannedAt: now().toISOString()
  }
}
