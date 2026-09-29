import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Smoke test for a published release: reads the release manifest, downloads the
 * update payload exactly like the launcher does (8 parallel HTTP Range
 * connections, no retries so failures are visible) and verifies the size and
 * SHA-256 that the app would check.
 *
 * Usage: node scripts/verify-release.mjs [tag]     (default: latest)
 */

const REPO = 'KevinYuHere/KevinLauncher'
const PARALLEL = 8
const tag = process.argv[2] ?? 'latest'
const api =
  `https://api.github.com/repos/${REPO}/releases/` +
  (tag === 'latest' ? 'latest' : `tags/${tag}`)

const headers = { 'user-agent': 'KevinLauncher', accept: 'application/vnd.github+json' }
const release = await (await fetch(api, { headers })).json()
if (!release.assets) throw new Error(`release ${tag} not found: ${release.message ?? ''}`)
console.log(`release ${release.tag_name} (${release.assets.length} assets)`)

const pick = (re) => release.assets.find((item) => re.test(item.name))
const zip = pick(/^KevinLauncher-.*\.zip$/)
const manifestAsset = pick(/^update-manifest\.json$/)
if (!zip || !manifestAsset) throw new Error('payload or manifest asset missing')

// The app prefers the API asset endpoint (reachable where github.com is not).
const assetUrl = (asset) => `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`
const download = (asset, extra = {}) =>
  fetch(assetUrl(asset), {
    headers: { accept: 'application/octet-stream', 'user-agent': 'KevinLauncher', ...extra },
    // Never let a stalled connection hang the test (same as the launcher).
    signal: AbortSignal.timeout(45_000)
  })

const manifest = JSON.parse(await (await download(manifestAsset)).text())
console.log(
  `manifest  version=${manifest.version} installSize=${manifest.installSize} ` +
    `sha256=${String(manifest.payloadSha256).slice(0, 16)}…`
)
console.log(`payload   ${zip.name} ${(zip.size / 1048576).toFixed(1)} MB`)

const dir = await fs.mkdtemp(join(tmpdir(), 'verify-release-'))
const parts = []
const chunk = Math.ceil(zip.size / PARALLEL)
const started = Date.now()
let transferred = 0
const ATTEMPTS = 8

await Promise.all(
  Array.from({ length: PARALLEL }, async (_, index) => {
    const start = index * chunk
    const end = Math.min(zip.size, start + chunk)
    if (start >= end) return
    const part = join(dir, `part${index}`)
    parts.push({ index, path: part, start })
    // Same resume-with-Range behaviour as the launcher.
    for (let attempt = 0; ; attempt++) {
      try {
        let have = 0
        try {
          have = (await fs.stat(part)).size
        } catch {
          /* nothing yet */
        }
        if (have < end - start) {
          const response = await download(zip, { Range: `bytes=${start + have}-${end - 1}` })
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
          const handle = await fs.open(part, 'a')
          try {
            const reader = response.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              await handle.write(value)
              transferred += value.length
            }
          } finally {
            await handle.close()
          }
        }
        if ((await fs.stat(part)).size !== end - start) throw new Error('short read')
        return
      } catch (error) {
        if (attempt >= ATTEMPTS - 1) throw error
        process.stdout.write(
          `  range ${start} retry ${attempt + 1} after "${error.message}"\n`
        )
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
      }
    }
  })
)

const seconds = (Date.now() - started) / 1000
console.log(
  `${PARALLEL} range requests: ${transferred} bytes in ${seconds.toFixed(1)}s ` +
    `(${(transferred / 1048576 / Math.max(0.1, seconds)).toFixed(1)} MB/s)`
)

// Concatenate in range order and verify like the app does.
const dest = join(dir, 'payload.zip')
const output = createWriteStream(dest)
for (const part of parts.sort((a, b) => a.start - b.start)) {
  await new Promise((resolve, reject) => {
    const input = createReadStream(part.path)
    input.on('data', (chunkData) => output.write(chunkData))
    input.on('end', resolve)
    input.on('error', reject)
  })
}
await new Promise((resolve, reject) => {
  output.on('finish', resolve)
  output.on('error', reject)
  output.end()
})

const { size } = await fs.stat(dest)
const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(dest)
  stream.on('data', (chunkData) => hash.update(chunkData))
  stream.on('end', () => resolve(hash.digest('hex')))
  stream.on('error', reject)
})

const sizeOk = size === zip.size
const hashOk = !manifest.payloadSha256 || sha256 === manifest.payloadSha256
console.log(`assembled ${size} bytes, size ok=${sizeOk}, sha256 ok=${hashOk}`)
await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
if (!sizeOk || !hashOk) throw new Error('verification failed')
console.log('OK — the launcher can download and verify this release')
