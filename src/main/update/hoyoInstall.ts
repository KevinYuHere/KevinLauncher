import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isFileSystemRoot } from '../services/directoryPath'
import { optionalText } from './hoyoFiles'
import type { HoYoGame } from './hoyoplay'

export const GAME_BIZ: Record<HoYoGame, string> = { genshin: 'hk4e_cn', starrail: 'hkrpg_cn', zzz: 'nap_cn' }
const executables: Record<HoYoGame, string[]> = {
  genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
  starrail: ['StarRail.exe'],
  zzz: ['ZenlessZoneZero.exe']
}

export async function readIni(dir: string): Promise<Map<string, string>> {
  const text = await optionalText(join(dir, 'config.ini')) ?? ''
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) entries.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim())
  }
  return entries
}

/** Older installations may lack identity fields. Recognizable mismatches stop before writes. */
export async function validateHoYoInstall(dir: string, game: HoYoGame): Promise<Map<string, string>> {
  if (!isAbsolute(dir) || isFileSystemRoot(dir) || !(await fs.stat(dir).catch(() => undefined))?.isDirectory()) {
    throw new Error('请选择已安装游戏的目录')
  }
  const ini = await readIni(dir)
  if (!/^\d+(?:\.\d+){0,3}$/.test(ini.get('game_version') ?? '')) throw new Error('无法读取已安装游戏版本')
  const biz = ini.get('game_biz')?.toLowerCase()
  if (biz && biz !== GAME_BIZ[game]) throw new Error('游戏目录的游戏或服务区与绑定模块不符')
  if (['channel', 'sub_channel'].some(key => ini.get(key) && ini.get(key) !== '1')) {
    throw new Error('当前只支持官方中国服游戏渠道')
  }
  const found: string[] = []
  for (const name of Object.values(executables).flat()) {
    if ((await fs.stat(join(dir, name)).catch(() => undefined))?.isFile()) found.push(name)
  }
  if ((found.length && !found.some(name => executables[game].includes(name))) ||
      (game === 'genshin' && found.includes('GenshinImpact.exe') && !found.includes('YuanShen.exe'))) {
    throw new Error('游戏目录的可执行文件与绑定游戏或服务区不符')
  }
  return ini
}
