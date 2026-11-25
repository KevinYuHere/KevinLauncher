import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { identifyFile, assetNames, verifyLocalAssets } from './release-assets.mjs'
import { parseUpdateCompatibility, STABLE_VERSION } from '../src/main/services/appUpdateManifest.ts'

/**
 * Builds the update payload for a release.
 *
 * The packaged launcher keeps its code in `resources/app-<version>/` and the
 * current version in `resources/app-version.txt`, so an
 * update only ships the **application code** — a few MB instead of the whole
 * unpacked app:
 *
 *   release/KevinLauncher-<version>-app.zip   resources/app-<version>/ of the build
 *   release/update-manifest.json              { version, electron, appSize,
 *                                               payloadSize, payloadSha256,
 *                                               installerName, installerSize,
 *                                               installerSha256 }
 *
 * The manifest also describes the full installer so the launcher can update
 * itself when the **runtime** (Electron) changed — it downloads the installer
 * and opens it instead of swapping files.
 *
 * Usage: node scripts/build-update-payload.mjs [unpackedDir] [version]
 */

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const unpacked = resolve(process.argv[2] ?? join(root, 'release', 'win-unpacked'))
const version =
  process.argv[3] ?? JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8')).version

// The update check orders releases with a SemVer comparator; a version that is
// not SemVer-shaped would be ordered as 0.0.0 and silently never offered again.
if (!STABLE_VERSION.test(version) || process.argv.length > 4) {
  throw new Error('正式更新包只接受正式版本和实际运行库')
}
/** Assets are written next to the unpacked directory (release/ by default). */
const outDir = resolve(unpacked, '..')

/** The application directory of this build. */
const appSource = join(unpacked, 'resources', `app-${version}`)
if (!(await fs.stat(appSource).catch(() => null))) {
  throw new Error(`找不到应用目录 ${appSource}（先运行 electron-builder）`)
}

/** Electron version the app was built against (updates need a matching runtime). */
const electron = JSON.parse(
  await fs.readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version
const [installerName, payloadName, manifestName] = assetNames(version)
const pointer = await fs.readFile(join(unpacked, 'resources', 'app-version.txt'), 'utf8')
if (pointer.trim() !== version) throw new Error('打包目录版本指针和发布版本不同')
const rootCompatibility = await fs.readFile(join(unpacked, 'resources', 'release-compatibility.json'), 'utf8')
const compatibility = parseUpdateCompatibility(JSON.parse(rootCompatibility))
if (!compatibility || rootCompatibility !== await fs.readFile(join(appSource, 'release-compatibility.json'), 'utf8')) {
  throw new Error('安装程序与应用更新包的兼容信息不一致')
}

/** Recursively lists every file, relative to `base` (always `/` separated). */
async function walk(base, dir = base, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(base, full, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

const files = await walk(appSource)
const appSize = (
  await Promise.all(files.map(async (path) => (await fs.stat(join(appSource, ...path.split('/')))).size))
).reduce((sum, size) => sum + size, 0)

// bsdtar (shipped with Windows) picks the format from the extension.
const zipPath = join(outDir, payloadName)
await fs.rm(zipPath, { force: true })
if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error('正式更新包需要 Windows 系统 tar.exe')
const tar = join(process.env.SystemRoot, 'System32', 'tar.exe')
await exec(tar, ['-a', '-cf', zipPath, '-C', appSource, '.'], { maxBuffer: 32 * 1024 * 1024 })

const { size: payloadSize, sha256: payloadSha256 } = await identifyFile(zipPath)

// Full installer (produced by electron-builder's portable target) — used when the
// runtime changed and the app cannot replace its own files while running.
const installerPath = join(outDir, installerName)
const { size: installerSize, sha256: installerSha256 } = await identifyFile(installerPath)
const unpackedFiles = await walk(unpacked)
const installerUnpackedSize = (
  await Promise.all(unpackedFiles.map(async file => (await fs.stat(join(unpacked, file))).size))
).reduce((sum, size) => sum + size, 0)

// Release notes are embedded so the free
// `releases/latest/download/update-manifest.json` path can show them without
// calling the GitHub API.
const notes = (await fs.readFile(join(outDir, 'RELEASE_NOTES.md'), 'utf8')).trim()

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
const critical = policy?.critical === true

await fs.writeFile(
  join(outDir, manifestName),
  JSON.stringify(
    {
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
      htmlUrl: `https://github.com/KevinYuHere/KevinLauncher/releases/tag/v${version}`
    },
    null,
    2
  ),
  'utf8'
)

console.log(
  `KevinLauncher-${version}-app.zip  ${files.length} files, ${(payloadSize / 1048576).toFixed(2)} MB packed` +
    ` (${(appSize / 1048576).toFixed(2)} MB unpacked) · electron ${electron}`
)
await verifyLocalAssets(outDir, version, electron)
console.log(`installer          ${installerName} (${(installerSize / 1048576).toFixed(1)} MB)`)
console.log('update-manifest.json            written')
