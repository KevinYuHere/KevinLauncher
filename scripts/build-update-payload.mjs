import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * Builds the update payload assets for a release from an unpacked app directory
 * (release/win-unpacked):
 *
 *   release/KevinLauncher-<version>.zip   the app tree (zip, deflate)
 *   release/update-manifest.json          { version, installSize, payloadSha256 }
 *
 * The in-app updater downloads the zip (multi-connection, resumable, pausable),
 * unpacks it into a staging directory (the "install progress" shown in the UI)
 * and swaps the files after restarting — so the user never sees the NSIS
 * installer UI and never has to choose anything.
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

/** Recursively lists every file, relative to `base` (always `/` separated). */
async function walk(base, dir = base, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(base, full, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

const files = await walk(unpacked)
const installSize = (
  await Promise.all(files.map(async (path) => (await fs.stat(join(unpacked, ...path.split('/')))).size))
).reduce((sum, size) => sum + size, 0)

// bsdtar (shipped with Windows) picks the format from the extension.
const zipPath = join(outDir, `KevinLauncher-${version}.zip`)
await fs.rm(zipPath, { force: true })
await exec('tar', ['-a', '-cf', zipPath, '-C', unpacked, '.'], { maxBuffer: 32 * 1024 * 1024 })

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
  JSON.stringify({ version, installSize, payloadSha256, payloadSize }, null, 2),
  'utf8'
)

console.log(
  `KevinLauncher-${version}.zip  ${files.length} files, ${(payloadSize / 1048576).toFixed(1)} MB packed` +
    ` (${(installSize / 1048576).toFixed(1)} MB unpacked)`
)
console.log('update-manifest.json       written')
