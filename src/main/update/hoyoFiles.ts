import { promises as fs } from 'fs'
import type { HoYoGame, HoYoGameConfig } from './hoyoplay'
import { isAbsolute, relative, resolve, sep } from 'path'
export { retryHoYo } from './hoyoNetwork'

export function gamePath(root: string, name: string): string {
  const target = resolve(root, name)
  const rel = relative(root, target)
  if (!rel || isAbsolute(name) || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || name.includes(':')) {
    throw new Error('无效的游戏资源路径')
  }
  return target
}

export async function optionalText(path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function readGameRows<T>(dir: string, name: string): Promise<T[]> {
  const input = await optionalText(gamePath(dir, name))
  return input ? input.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(row => row != null) : []
}

export async function getScenario(dir: string, config: HoYoGameConfig): Promise<string> {
  if (config.enableScenario && config.scenarioFile) {
    const json = await optionalText(gamePath(dir, config.scenarioFile))
    if (json && JSON.parse(json)?.packageType === 'BASE') return 'CATEGORY_SCENARIO_BASE'
  }
  return 'CATEGORY_SCENARIO_FULL'
}

export async function selectionFiles(game: HoYoGame, dir: string, config: HoYoGameConfig) {
  const ignored = config.resCategoryDir
    ? await readGameRows<{ category: string; is_delete: boolean }>(dir, config.resCategoryDir) : []
  const ignoreFields = ignored.filter(row => row.is_delete && row.category?.trim()).map(row => row.category)
  const blacklist: string[] = []
  for (const name of [config.enableBlacklist ? config.blacklistDir : '', game === 'genshin' ? 'CutsceneBlockList.jsonl' : ''].filter(Boolean)) {
    const rows = await readGameRows<{ fileName: string }>(dir, name)
    blacklist.push(...rows.map(row => row.fileName).filter(value => value?.trim()))
  }
  return { ignoreFields, blacklist }
}
