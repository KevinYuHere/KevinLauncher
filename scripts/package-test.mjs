import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { STABLE_VERSION } from '../src/main/services/appUpdateManifest.ts'
import { buildWindowsInstaller } from './build-windows-installer.mjs'

const betaPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.[1-9]\d*$/
const sourceDirectories = ['scripts', 'src', 'resources', 'shell', 'tests']
const buildConfigs = ['electron-builder.yml', 'electron.vite.config.ts', 'vitest.config.ts']
const excludedInputs = /^(?:\.env(?:\.|$)|\.git$|\.DS_Store$|node_modules$|__pycache__$)|\.(?:local|log)$/i

function compareCoreVersions(a, b) {
  const left = a.split('-')[0].split('.').map(part => BigInt(part))
  const right = b.split('-')[0].split('.').map(part => BigInt(part))
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0n
    const y = right[index] ?? 0n
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function betaPackageMetadata(manifest, lock, requested) {
  const version = manifest.version
  if (!STABLE_VERSION.test(version) || version !== lock.version || version !== lock.packages?.['']?.version) {
    throw new Error('package.json 和 package-lock.json 必须使用同一正式版本号')
  }
  const nextCore = version.split('.').map(part => BigInt(part))
  nextCore[2] += 1n
  const next = nextCore.map(String).join('.')
  const beta = requested ?? next + '-beta.1'
  if (!betaPattern.test(beta)) {
    throw new Error('Beta 版本号必须使用 x.y.z-beta.n 格式，例如 ' + version + '-beta.1 或 ' + next + '-beta.1')
  }
  // An in-tree stable target may still be unpublished, so an explicit Beta of
  // that same core is valid; only a strictly older core is rejected.
  if (compareCoreVersions(beta, version) < 0) {
    throw new Error('Beta 版本号的主版本不能低于 ' + version + '，例如 ' + version + '-beta.1 或 ' + next + '-beta.1')
  }
  return [
    { ...manifest, version: beta },
    { ...lock, version: beta, packages: { ...lock.packages, '': { ...lock.packages[''], version: beta } } }
  ]
}

export async function copyBetaBuildInputs(root, source) {
  await mkdir(source)
  for (const directory of sourceDirectories) {
    await cp(join(root, directory), join(source, directory), {
      recursive: true,
      filter: async path => {
        if (excludedInputs.test(basename(path)) || path === join(root, 'scripts', 'verify.ps1')) return false
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Beta 构建输入不能为符号链接：' + path)
        return true
      }
    })
  }
  const rootFiles = await readdir(root)
  const configs = buildConfigs.concat(rootFiles.filter(file => /^tsconfig(?:\.[\w-]+)*\.json$/.test(file)))
  if (rootFiles.includes('theme-policy.json')) configs.push('theme-policy.json')
  for (const file of configs) {
    const from = join(root, file)
    if (!(await lstat(from)).isFile()) throw new Error('Beta 构建输入必须是普通文件：' + file)
    await copyFile(from, join(source, file))
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('本地 Beta 安装包须在 Windows 上构建')
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, 'keep-unpacked': { type: 'boolean' }, 'build-only': { type: 'boolean' }
  } })
  const root = resolve(import.meta.dirname, '..')
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async file =>
    JSON.parse(await readFile(join(root, file), 'utf8'))))
  const [betaManifest, betaLock] = betaPackageMetadata(manifest, lock, values.version)

  const output = await mkdtemp(join(root, 'release-beta-'))
  const source = join(output, 'source')
  const modules = join(source, 'node_modules')
  let installer
  try {
    await copyBetaBuildInputs(root, source)
    for (const [file, content] of [['package.json', betaManifest], ['package-lock.json', betaLock]]) {
      await writeFile(join(source, file), JSON.stringify(content, null, 2) + '\n')
    }
    await cp(join(root, 'node_modules'), modules, { recursive: true })
    if (values['build-only']) {
      // Hosted acceptance skips the duplicate full suite only after the exact
      // main push CI succeeded; the real package and its verifier still run.
      console.log('--build-only：仅限已通过精确 main push CI 的托管验收，跳过重复的 typecheck 与测试')
    } else {
      for (const command of ['npm.cmd run typecheck', 'npm.cmd test']) {
        execFileSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: source, stdio: 'inherit' })
      }
    }
    const build = buildWindowsInstaller(source)
    const filename = basename(build.installer)
    const sha = createHash('sha256')
    for await (const chunk of createReadStream(build.installer)) sha.update(chunk)
    if (values['keep-unpacked']) await rename(build.unpacked, join(output, 'win-unpacked'))
    const verification = {
      version: betaManifest.version, installer: filename, ...build.modes,
      size: (await stat(build.installer)).size, sha256: sha.digest('hex')
    }
    installer = join(output, filename)
    await rename(build.installer, installer)
    await writeFile(join(output, 'beta-verification.json'), JSON.stringify(verification, null, 2) + '\n')
  } catch (error) {
    if (installer) await rm(installer, { force: true })
    throw error
  } finally {
    await rm(source, { recursive: true, force: true, maxRetries: 3 })
  }
  console.log(installer)
}

if (import.meta.main) await main()
