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
 *                                               payloadSize, payloadSha256 }
 *
 * The launcher unpacks it into a fresh `resources/app-<new version>/` while it is
 * running (nothing in use is touched), then flips `app-version.txt` and restarts.
 *
 * Usage: node scripts/build-update-payload.mjs [unpackedDir] [version]
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
const electron = JSON.parse(
  await fs.readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

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

await fs.writeFile(
  join(outDir, 'update-manifest.json'),
  JSON.stringify({ version, electron, appSize, payloadSize, payloadSha256 }, null, 2),
  'utf8'
)

console.log(
  `KevinLauncher-${version}-app.zip  ${files.length} files, ${(payloadSize / 1048576).toFixed(2)} MB packed` +
    ` (${(appSize / 1048576).toFixed(2)} MB unpacked) · electron ${electron}`
)
console.log('update-manifest.json            written')
