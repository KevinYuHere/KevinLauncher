import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { configMediaReferences, isMediaFilename, MEDIA_DIRECTORIES } from '../src/shared/mediaReferences.ts'

// Only include persisted settings and media needed for a trial. The Chromium
// profile, login tokens, and tasks are bound to the original environment.
const entries = ['config.json', 'theme-policy.json', 'playtime.json', ...MEDIA_DIRECTORIES, 'gacha']

function inside(parent, child) {
  return parent.toLowerCase() === child.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + sep)
}

async function getEntry(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

async function copy(source, target, beforeFile) {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) throw new Error('试用种子不能包含重定向：' + source)
  if (stat.isDirectory()) {
    await mkdir(target)
    for (const entry of await readdir(source)) await copy(join(source, entry), join(target, entry), beforeFile)
  } else if (stat.isFile()) {
    await beforeFile(source)
    await copyFile(source, target, constants.COPYFILE_EXCL)
  } else {
    throw new Error('试用种子包含不支持的文件：' + source)
  }
}

export async function seedTrial(source, trialRoot, { replace = false, beforeFile = async (_file = '') => {} } = {}) {
  const canonical = await realpath(source)
  const root = resolve(trialRoot)
  if (inside(root, canonical) || inside(canonical, root)) throw new Error('试用种子和目标目录不能重叠')
  await mkdir(root, { recursive: true })
  if (relative(root, await realpath(root)) || !(await lstat(root)).isDirectory()) {
    throw new Error('试用根目录须为未重定向的实体目录')
  }
  const target = join(root, 'data')
  const lock = join(root, 'seed-in-progress')
  await mkdir(lock)
  let stage
  let retired
  try {
    const current = await getEntry(target)
    if (current && (!current.isDirectory() || relative(target, await realpath(target)))) {
      throw new Error('试用数据目录须为未重定向的实体目录')
    }
    if (current && !replace) throw new Error('试用数据已存在，指定 -Reseed 才会替换')
    stage = await mkdtemp(join(root, 'data-seed-'))
    for (const entry of entries) {
      const from = join(canonical, entry)
      if (entry === 'config.json' || await getEntry(from)) await copy(from, join(stage, entry), beforeFile)
    }
    const copied = JSON.parse(await readFile(join(stage, 'config.json'), 'utf8'))
    if (!Array.isArray(copied?.apps)) throw new Error('试用种子的 config.json 缺少应用列表')
    for (const [dir, file] of configMediaReferences(copied, true)) {
      if (!isMediaFilename(file)) throw new Error('试用种子包含无效的媒体文件名')
      if (!(await getEntry(join(stage, dir, file)))?.isFile()) {
        throw new Error('试用种子缺少引用的媒体：' + dir + '/' + file)
      }
    }
    if (current) {
      retired = join(root, 'data-retired-' + randomUUID())
      await rename(target, retired)
    }
    try {
      await rename(stage, target)
    } catch (error) {
      if (retired) await rename(retired, target)
      throw error
    }
    if (retired) await rm(retired, { recursive: true, force: true })
    return target
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true })
    } finally {
      await rmdir(lock)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.LOCALAPPDATA
  if (!base || !isAbsolute(base)) throw new Error('无法定位本地试用目录')
  const target = await seedTrial(process.argv[2], join(await realpath(base), 'KevinLauncherTrial'), {
    replace: process.argv[3] === '--replace'
  })
  console.log(target)
}
