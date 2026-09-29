import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * Builds the update payload for a release.
 *
 * The packaged launcher keeps its code in `resources/app-<version>/` and the
 * current version in `resources/app-version.txt` (see docs/INSTALLER.md), so an
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
 * Usage: node scripts/build-update-payload.mjs [unpackedDir] [version] [electron]
 *        (the third argument overrides the recorded Electron version, which is
 *         useful to test a runtime upgrade end to end)
 */

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const unpacked = resolve(process.argv[2] ?? join(root, 'release', 'win-unpacked'))
const version =
  process.argv[3] ?? JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8')).version
/** Assets are written next to the unpacked directory (release/ by default). */
const outDir = resolve(unpacked, '..')

/** The application directory of this build. */
const appSource = join(unpacked, 'resources', `app-${version}`)
if (!(await fs.stat(appSource).catch(() => null))) {
  throw new Error(`找不到应用目录 ${appSource}（先运行 electron-builder）`)
}

/** Electron version the app was built against (updates need a matching runtime). */
const builtElectron = JSON.parse(
  await fs.readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version
const electron = process.argv[4] ?? builtElectron
if (electron !== builtElectron) {
  console.log(`!! 记录为 Electron ${electron}（实际 ${builtElectron}）— 用于测试运行库升级路径`)
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
const zipPath = join(outDir, `KevinLauncher-${version}-app.zip`)
await fs.rm(zipPath, { force: true })
await exec('tar', ['-a', '-cf', zipPath, '-C', appSource, '.'], { maxBuffer: 32 * 1024 * 1024 })

const payloadSha256 = await new Promise((resolveHash, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(zipPath)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => resolveHash(hash.digest('hex')))
  stream.on('error', reject)
})
const { size: payloadSize } = await fs.stat(zipPath)

// Full installer (produced by electron-builder's portable target) — used when the
// runtime changed and the app cannot replace its own files while running.
const installerName = `KevinLauncher-Installer-${version}.exe`
const installerPath = join(outDir, installerName)
let installerSize = 0
let installerSha256 = null
if (await fs.stat(installerPath).catch(() => null)) {
  installerSize = (await fs.stat(installerPath)).size
  installerSha256 = await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(installerPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

await fs.writeFile(
  join(outDir, 'update-manifest.json'),
  JSON.stringify(
    {
      version,
      electron,
      appSize,
      payloadSize,
      payloadSha256,
      installerName: installerSize ? installerName : null,
      installerSize,
      installerSha256
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
console.log(
  installerSize
    ? `installer          ${installerName} (${(installerSize / 1048576).toFixed(1)} MB)`
    : 'installer          （未找到，运行库升级将无法自动下载）'
)
console.log('update-manifest.json            written')
