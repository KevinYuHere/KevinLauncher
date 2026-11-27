import type { AddonId, NewAppEntry } from './types'

/**
 * Read-only local game discovery.
 *
 * Candidates are only produced after the game executable **and** a known
 * install marker were found in a path read from the local registry or a short,
 * fixed list of common install locations. Nothing here describes update
 * availability: a detected game can still be unsupported / not updatable, and
 * that decision stays with the update page.
 */
export type GameDiscoverySource = 'registry' | 'common-path'

export interface GameDiscoveryCandidate {
  game: AddonId
  /** Display name of the add-on (原神 / 崩坏：星穹铁道 / 绝区零 / 明日方舟). */
  name: string
  /** Directory that contains the verified executable and marker. */
  installDirectory: string
  executablePath: string
  executableName: string
  /** Known install marker (for example `YuanShen_Data`). */
  marker: string
  source: GameDiscoverySource
  /** True when an existing app already points at this directory/executable. */
  alreadyAdded: boolean
}

export interface GameDiscoveryResult {
  candidates: GameDiscoveryCandidate[]
  /** Non-fatal problems, e.g. the registry could not be read. */
  warnings: string[]
  scannedAt: string
}

/** Game discovery methods merged into `KevinApi` and exposed by preload. */
export interface GameDiscoveryApi {
  gameDiscoveryScan(): Promise<GameDiscoveryResult>
}

/** Minimal shape used for duplicate detection (a real `AppEntry` fits). */
export interface GameDiscoveryExistingApp {
  gameDirectory?: string | null
  launchMethods?: readonly { targetPath?: string | null }[]
}

/**
 * Case/separator-insensitive identity for Windows paths. Shared with the
 * renderer so the confirmation list and the main-process scan agree on what
 * "already added" means.
 */
export function normalizeGamePath(value: string | null | undefined): string {
  if (!value) return ''
  let path = value.trim().replace(/\//g, '\\')
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`
  else if (/^\\\\\?\\/i.test(path)) path = path.slice(4)
  while (path.length > 3 && path.endsWith('\\')) path = path.slice(0, -1)
  return path.toLowerCase()
}

/** Whether an app already points at the candidate's install directory or exe. */
export function isGameDiscoveryCandidateAlreadyAdded(
  candidate: Pick<GameDiscoveryCandidate, 'installDirectory' | 'executablePath'>,
  apps: readonly GameDiscoveryExistingApp[]
): boolean {
  const installDirectory = normalizeGamePath(candidate.installDirectory)
  const executablePath = normalizeGamePath(candidate.executablePath)
  if (!installDirectory || !executablePath) return false
  return apps.some((app) => {
    if (normalizeGamePath(app.gameDirectory) === installDirectory) return true
    return (app.launchMethods ?? []).some(
      (method) => normalizeGamePath(method.targetPath) === executablePath
    )
  })
}

/**
 * Build the payload for the existing `apps:add` command. Discovery never adds
 * anything itself: the renderer calls this only after the user checked the
 * candidate and confirmed the import.
 */
export function discoveredGameToNewApp(candidate: GameDiscoveryCandidate): NewAppEntry {
  return {
    name: candidate.name,
    addonId: candidate.game,
    gameDirectory: candidate.installDirectory,
    launchMethods: [
      {
        targetPath: candidate.executablePath,
        arguments: '',
        workingDirectory: candidate.installDirectory,
        runAsAdmin: true
      }
    ],
    monitorProcessNames: [candidate.executableName]
  }
}
