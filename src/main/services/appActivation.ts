import { promises as fs } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './atomicFile'
import { loadedApplication } from './appVersion'
import { SAFE_VERSION } from './appUpdateManifest'

const marker = 'app-activation.json'

interface Activation {
  schema: 1
  healthy?: string
  previousHealthy?: string
  rejected?: string
  pending?: { target: string; previous: string; attempts: number; pid?: number }
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SAFE_VERSION.test(value)
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

export function recordApplicationStartup(): void {
  loadedApplication()?.recordStartup?.()
}

export async function prepareApplicationActivation(target: string): Promise<void> {
  const loaded = loadedApplication()
  if (!loaded || !isVersion(target) || target === loaded.version) throw new Error('无法识别当前应用版本')
  const state = await readActivation()
  if (state.rejected === target) throw new Error('这个版本上次启动失败，请使用完整安装包')
  if (state.pending && state.pending.target !== target) throw new Error('已有待确认的程序更新')
  await saveActivation({
    ...state,
    healthy: loaded.version,
    pending: { target, previous: loaded.version, attempts: 0 }
  })
  try {
    await writeFileAtomic(join(process.resourcesPath, 'app-version.txt'), target)
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
