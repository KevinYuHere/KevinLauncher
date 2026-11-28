import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { compareVersions, isSemVerVersion } from '@shared/version'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { loadedApplication } from './appVersion'
import { SAFE_VERSION } from './appUpdateManifest'
import { log } from './logger'

const marker = 'app-activation.json'
const upgradeSourceFile = 'upgrade-source.json'

interface Activation {
  schema: 1
  healthy?: string
  previousHealthy?: string
  rejected?: string
  pending?: { target: string; previous: string; attempts: number; pid?: number }
}

/** Durable proof that a real previous version was replaced by `to`. */
export interface UpgradeSource {
  schema: 1
  from: string
  to: string
  source: 'hot' | 'install'
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SAFE_VERSION.test(value)
}

function normalizedVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const version = value.trim().replace(/^v/i, '')
  return isSemVerVersion(version) ? version : null
}

async function readActivation(): Promise<Activation> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(process.resourcesPath, marker), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1 }
    throw error
  }
  const state = raw as Activation | null
  if (!state || state.schema !== 1 ||
      [state.healthy, state.previousHealthy, state.rejected].some(value => value != null && !isVersion(value)) ||
      state.pending && (!isVersion(state.pending.target) || !isVersion(state.pending.previous) ||
        state.pending.target === state.pending.previous ||
        !Number.isSafeInteger(state.pending.attempts) || state.pending.attempts < 0)) {
    throw new Error('自更新激活记录无效')
  }
  return state
}

async function saveActivation(state: Activation): Promise<void> {
  await writeFileAtomic(join(process.resourcesPath, marker), JSON.stringify(state))
}

/**
 * Persist the actual installed version observed **before** switching the
 * application directory/pointer. Both hot updates and full installers leave
 * this proof; the new version consumes it only after its main window is healthy.
 */
export async function recordUpgradeSource(
  dataDir: string,
  from: string,
  to: string,
  source: UpgradeSource['source']
): Promise<void> {
  const previous = normalizedVersion(from)
  const target = normalizedVersion(to)
  if (!previous || !target || compareVersions(previous, target) >= 0) {
    throw new Error('升级来源版本无效')
  }
  await writeFileAtomic(
    join(dataDir, upgradeSourceFile),
    JSON.stringify({ schema: 1, from: previous, to: target, source } satisfies UpgradeSource)
  )
}

/** Read a validated upgrade proof; missing/corrupt/unreadable files are a quiet miss. */
export async function readUpgradeSource(dataDir: string): Promise<UpgradeSource | null> {
  const result = await loadJsonSafe<unknown>(join(dataDir, upgradeSourceFile))
  if (result.status !== 'ok' || !result.value || typeof result.value !== 'object') return null
  const value = result.value as Partial<UpgradeSource>
  if (value.schema !== 1 || (value.source !== 'hot' && value.source !== 'install')) return null
  const from = normalizedVersion(value.from)
  const to = normalizedVersion(value.to)
  if (!from || !to || compareVersions(from, to) >= 0) return null
  return { schema: 1, from, to, source: value.source }
}

/** Best-effort removal after the target version has consumed or rejected the proof. */
export async function clearUpgradeSource(dataDir: string): Promise<void> {
  await fs.rm(join(dataDir, upgradeSourceFile), { force: true }).catch((error) => {
    log(`appActivation: could not clear upgrade source (${String(error)})`)
  })
}

export function recordApplicationStartup(): void {
  loadedApplication()?.recordStartup?.()
}

export async function prepareApplicationActivation(target: string): Promise<void> {
  const loaded = loadedApplication()
  if (!loaded || !isVersion(target) || target === loaded.version) throw new Error('无法识别当前应用版本')
  const previous = normalizedVersion(loaded.version)
  const next = normalizedVersion(target)
  if (!previous || !next || compareVersions(previous, next) >= 0) {
    throw new Error('更新目标版本无效')
  }
  const state = await readActivation()
  if (state.rejected === next) throw new Error('这个版本上次启动失败，请使用完整安装包')
  if (state.pending && state.pending.target !== next) throw new Error('已有待确认的程序更新')
  // The proof is written before the pointer can select the new version.
  await recordUpgradeSource(app.getPath('userData'), previous, next, 'hot')
  await saveActivation({
    ...state,
    healthy: previous,
    pending: { target: next, previous, attempts: 0 }
  })
  try {
    await writeFileAtomic(join(process.resourcesPath, 'app-version.txt'), next)
  } catch (error) {
    try {
      await saveActivation(state)
    } catch {
      throw new Error('无法恢复更新激活记录，请重启启动器后重试', { cause: error })
    }
    throw error
  }
}

export async function confirmApplicationActivation(): Promise<void> {
  const loaded = loadedApplication()
  if (!loaded) return
  const state = await readActivation()
  const pointer = join(process.resourcesPath, 'app-version.txt')
  const version = (await fs.readFile(pointer, 'utf8').catch(() => '')).trim()
  if (loaded.pending && state.pending?.target !== loaded.version) throw new Error('自更新激活记录已经改变')
  if (state.pending?.target === loaded.version) {
    await saveActivation({
      schema: 1, healthy: loaded.version, previousHealthy: state.pending.previous, rejected: state.rejected
    })
  } else if (state.pending?.previous === loaded.version && state.pending.target !== version) {
    // The previous process stopped before committing its version pointer.
    // Keep the old installed app and allow the cached download to be retried.
    await saveActivation({ ...state, healthy: loaded.version, pending: undefined })
  } else if (state.healthy !== loaded.version && !state.pending) {
    await saveActivation({
      ...state, healthy: loaded.version,
      previousHealthy: state.previousHealthy === loaded.version ? undefined : state.previousHealthy
    })
  }
  // A successful fallback also repairs a missing or invalid pointer.
  if (version !== loaded.version && (!state.pending || state.pending.previous === loaded.version)) {
    await writeFileAtomic(pointer, loaded.version)
  }
}

export async function protectedApplicationVersions(): Promise<Set<string>> {
  const [state, pointer] = await Promise.all([
    readActivation(),
    fs.readFile(join(process.resourcesPath, 'app-version.txt'), 'utf8').catch(() => '')
  ])
  const versions = [
    loadedApplication()?.version, pointer.trim(), state.healthy, state.previousHealthy,
    state.pending?.target, state.pending?.previous
  ].filter(isVersion)
  return new Set(versions)
}

export async function rejectedApplicationVersion(): Promise<string | undefined> {
  if (!loadedApplication()) return undefined
  return (await readActivation()).rejected
}
