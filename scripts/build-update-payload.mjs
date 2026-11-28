import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  deltaAssetName,
  installerAssetName,
  parseUpdateCompatibility,
  payloadAssetName,
  SAFE_VERSION,
  STABLE_VERSION
} from '../src/main/services/appUpdateManifest.ts'
import { identifyFile, verifyLocalAssets } from './release-assets.mjs'

/**
 * Builds update assets from a staged Windows application.
 *
 * The packaged launcher keeps its code in `resources/app-<version>/` and the
 * current version in `resources/app-version.txt`, so an app-only update is a
 * ZIP of that versioned directory. The same builder is shared by the official
 * stable path and the Beta path: both publish
 *
 *   <outDir>/KevinLauncher-<version>-app.zip
 *   <outDir>/update-manifest.json
 *
 * A Beta release additionally publishes its legacy installer pair and may add
 * one exact-source delta to the manifest. The official stable command is still
 *
 *   node scripts/build-update-payload.mjs [unpackedDir] [version]
 */

const require = createRequire(import.meta.url)
const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
const root = resolve(import.meta.dirname, '..')
const RUNTIME_EXE = 'KevinLauncherRuntime.exe'

/** Recursively lists every regular file, relative to `base` (`/` separated). */
export async function walkFiles(base, dir = base, out = []) {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error('更新包不能包含符号链接：' + full)
    if (entry.isDirectory()) await walkFiles(base, full, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
    else throw new Error('更新包包含不支持的文件类型：' + full)
  }
  return out
}

async function totalSize(base, files) {
  let total = 0
  for (const file of files) total += (await fs.stat(join(base, ...file.split('/')))).size
  return total
}

/**
 * Electron version embedded in the packaged runtime executable.
 *
 * Reading the actual PE resource is deliberate: `node_modules/electron` may
 * describe a different runtime than the staged application (or be absent from
 * a frozen release batch), while the manifest must describe the bytes users
 * will actually run.
 */
export async function readRuntimeElectronVersion(unpacked) {
  const runtime = join(resolve(unpacked), RUNTIME_EXE)
  let stat
  try {
    stat = await fs.stat(runtime)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!stat?.isFile()) throw new Error(`找不到 Windows 运行库 ${runtime}`)

  let resources
  try {
    const executable = NtExecutable.from(await fs.readFile(runtime), { ignoreCert: true })
    resources = NtExecutableResource.from(executable).entries
  } catch (error) {
    throw new Error(`无法读取 Windows 运行库版本：${error.message}`)
  }
  const versions = new Set()
  for (const info of Resource.VersionInfo.fromEntries(resources)) {
    for (const language of info.getAllLanguagesForStringValues()) {
      const values = info.getStringValues(language)
      const version = values.ProductVersion || values.FileVersion
      if (version) versions.add(String(version).trim())
    }
  }
  if (versions.size !== 1) throw new Error('Windows 运行库缺少唯一的产品版本')
  const [electron] = versions
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(electron)) {
    throw new Error(`Windows 运行库版本无效：${electron}`)
  }
  return electron
}

/** Replaces `update-manifest.json` in one step, never leaving a half file. */
export async function writeUpdateManifest(outDir, manifest) {
  const manifestPath = join(resolve(outDir), 'update-manifest.json')
  const temporary = `${manifestPath}.${process.pid}-${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
    await fs.rename(temporary, manifestPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/** Packs `appSource` as a ZIP that the Windows bsdtar extractor accepts. */
export async function buildAppZip(appSource, zipPath) {
  await fs.mkdir(dirname(zipPath), { recursive: true })
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw new Error('应用更新包需要 Windows 系统 tar.exe')
  }
  const tar = join(process.env.SystemRoot, 'System32', 'tar.exe')
  const temporary = `${zipPath}.${process.pid}-${randomUUID()}.tmp.zip`
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(tar, ['-a', '-cf', temporary, '-C', appSource, '.'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('exit', code => {
        if (code === 0) resolvePromise()
        else reject(new Error(`应用更新包打包失败（tar 退出码 ${code}）`))
      })
    })
    await fs.rm(zipPath, { force: true })
    await fs.rename(temporary, zipPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * Builds one complete app payload and manifest.
 *
 * @param {{
 *   unpacked: string,
 *   version: string,
 *   outDir?: string,
 *   notes?: string,
 *   critical?: boolean,
 *   delta?: { fromVersion: string, name: string, size: number, sha256: string } | null
 * }} options
 */
export async function buildApplicationUpdate(options) {
  const unpacked = resolve(options.unpacked)
  const outDir = resolve(options.outDir ?? join(unpacked, '..'))
  const version = options.version
  const notes = String(options.notes ?? '').trim()
  const critical = options.critical === true
  if (!SAFE_VERSION.test(version)) throw new Error('更新包版本号无效')

  const resources = join(unpacked, 'resources')
  const appSource = join(resources, `app-${version}`)
  const appStat = await fs.lstat(appSource).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!appStat?.isDirectory() || appStat.isSymbolicLink()) {
    throw new Error(`找不到应用目录 ${appSource}（先运行 electron-builder）`)
  }
  const pointer = await fs.readFile(join(resources, 'app-version.txt'), 'utf8').catch(() => '')
  if (pointer.trim() !== version) throw new Error('打包目录版本指针和发布版本不同')

  const metadata = JSON.parse(await fs.readFile(join(appSource, 'package.json'), 'utf8'))
  if (metadata?.version !== version) throw new Error('应用目录版本与发布版本不同')

  const rootCompatibility = await fs.readFile(join(resources, 'release-compatibility.json'), 'utf8')
  const appCompatibility = await fs.readFile(join(appSource, 'release-compatibility.json'), 'utf8')
  const compatibility = parseUpdateCompatibility(JSON.parse(rootCompatibility))
  if (!compatibility || rootCompatibility !== appCompatibility) {
    throw new Error('安装程序与应用更新包的兼容信息不一致')
  }

  // The runtime is the authority for the value written to the manifest.
  const electron = await readRuntimeElectronVersion(unpacked)

  const installerName = installerAssetName(version)
  const installerPath = join(outDir, installerName)
  const { size: installerSize, sha256: installerSha256 } = await identifyFile(installerPath)
  const unpackedFiles = await walkFiles(unpacked)
  const installerUnpackedSize = await totalSize(unpacked, unpackedFiles)

  const files = await walkFiles(appSource)
  const appSize = await totalSize(appSource, files)
  const payloadName = payloadAssetName(version)
  const zipPath = join(outDir, payloadName)
  await buildAppZip(appSource, zipPath)
  const { size: payloadSize, sha256: payloadSha256 } = await identifyFile(zipPath)

  let delta = null
  if (options.delta) {
    const fromVersion = options.delta.fromVersion
    const name = options.delta.name
    if (!SAFE_VERSION.test(fromVersion) || fromVersion === version ||
        name !== deltaAssetName(fromVersion, version) || basename(name) !== name) {
      throw new Error('差量包的源版本或文件名无效')
    }
    const actual = await identifyFile(join(outDir, name))
    if (actual.size !== options.delta.size || actual.sha256 !== String(options.delta.sha256).toLowerCase()) {
      throw new Error('差量包大小或 SHA-256 与构建结果不一致')
    }
    if (actual.size >= payloadSize) throw new Error('差量包未小于完整应用包，拒绝发布无效差量')
    delta = { fromVersion, name, size: actual.size, sha256: actual.sha256 }
  }

  const manifest = {
    version,
    electron,
    compatibility,
    appSize,
    payloadSize,
    payloadSha256,
    installerName,
    installerSize,
    installerUnpackedSize,
    installerSha256,
    notes,
    critical,
    ...(delta ? { delta } : {}),
    htmlUrl: `https://github.com/KevinYuHere/KevinLauncher/releases/tag/v${version}`
  }
  await writeUpdateManifest(outDir, manifest)

  return {
    manifest,
    unpacked,
    outDir,
    appSource,
    electron,
    compatibility,
    appSize,
    payloadName,
    payloadPath: zipPath,
    payloadSize,
    payloadSha256,
    installerName,
    installerPath,
    installerSize,
    installerSha256,
    installerUnpackedSize,
    files
  }
}

async function buildStable() {
  const unpacked = resolve(process.argv[2] ?? join(root, 'release', 'win-unpacked'))
  const version =
    process.argv[3] ?? JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8')).version

  // The update check orders releases with a SemVer comparator; a version that
  // is not SemVer-shaped would be ordered as 0.0.0 and silently never offered.
  if (!STABLE_VERSION.test(version) || process.argv.length > 4) {
    throw new Error('正式更新包只接受正式版本和实际运行库')
  }
  const outDir = resolve(unpacked, '..')

  // Release notes are embedded so the free
  // `releases/latest/download/update-manifest.json` path can show them without
  // calling the GitHub API.
  const notes = (await fs.readFile(join(outDir, 'RELEASE_NOTES.md'), 'utf8')).trim()
  if (!notes) throw new Error('RELEASE_NOTES.md 为空')

  // Only the versioned policy may mark a release as critical.
  let policy = null
  try {
    policy = JSON.parse(await fs.readFile(join(root, 'theme-policy.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (policy && policy.version !== version) {
    // The client applies a policy only on the version it was written for, and
    // `afterPack` refuses to embed a stale one - so this build would ship without
    // its settings. Force the author to clean up instead of publishing silently.
    throw new Error(
      `theme-policy.json 属于 ${policy.version}，本次发布是 ${version}：` +
        `请删除它；如果 ${version} 也需要调整用户设置，请把 version 改成 ${version}`
    )
  }

  const built = await buildApplicationUpdate({
    unpacked,
    outDir,
    version,
    notes,
    critical: policy?.critical === true
  })
  await verifyLocalAssets(outDir, version, built.electron)
  console.log(
    `${built.payloadName}  ${built.files.length} files, ${(built.payloadSize / 1048576).toFixed(2)} MB packed` +
      ` (${(built.appSize / 1048576).toFixed(2)} MB unpacked) · electron ${built.electron}`
  )
  console.log(`installer          ${built.installerName} (${(built.installerSize / 1048576).toFixed(1)} MB)`)
  console.log('update-manifest.json            written')
}

if (import.meta.main) await buildStable()
