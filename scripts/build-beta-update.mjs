import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isNewerVersion } from '../src/shared/version.ts'
import { buildAppDelta, inventoryAppTree } from '../src/main/services/appUpdateDelta.ts'
import {
  deltaAssetName,
  isBetaVersion,
  parseBetaVerification,
  SAFE_VERSION
} from '../src/main/services/appUpdateManifest.ts'
import { buildApplicationUpdate, writeUpdateManifest } from './build-update-payload.mjs'
import { identifyFile, verifyBetaLocalAssets } from './release-assets.mjs'

/**
 * Builds the update assets of a verified Beta batch:
 *
 *   KevinLauncher-<version>-app.zip       full versioned application only
 *   update-manifest.json                  conventional stable-compatible data
 *   [KevinLauncher-<from>-to-<version>-delta.json.gz]
 *
 * The installer and `beta-verification.json` are kept as-is for older clients.
 * A delta is included only for the exact version in the supplied inventory and
 * only when it is strictly smaller than the full app ZIP.
 *
 * Usage:
 *   node scripts/build-beta-update.mjs --inventory <base-app-dir> <base-beta-version>
 *   node scripts/build-beta-update.mjs <release-beta-batch-dir> [base-inventory-file]
 *
 * The first form prints one compact JSON inventory on stdout. Neither form
 * accesses the network.
 */

const PREFERRED_DELTA_BYTES = 100 * 1024

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeAtomic(file, data) {
  await fs.mkdir(dirname(resolve(file)), { recursive: true })
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/** Strictly one exact application version, printed without any other stdout. */
async function printInventory(baseDirectory, baseVersion) {
  if (!isBetaVersion(baseVersion)) throw new Error('基础版本必须是 x.y.z-beta.n')
  const base = resolve(baseDirectory)
  const metadata = await readJson(join(base, 'package.json'))
  if (metadata?.version !== baseVersion) {
    throw new Error(`基础应用目录的版本 ${metadata?.version ?? '未知'} 与 ${baseVersion} 不同`)
  }
  const inventory = await inventoryAppTree(base, baseVersion)
  process.stdout.write(JSON.stringify(inventory) + '\n')
}

async function readBetaNotes(batch) {
  try {
    return (await fs.readFile(join(batch, 'RELEASE_NOTES.md'), 'utf8')).trim()
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** Removes a delta left by an earlier run of this same target version. */
async function removeStaleDeltas(batch, version, keep) {
  const suffix = `-to-${version}-delta.json.gz`
  for (const entry of await fs.readdir(batch, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix) && entry.name !== keep) {
      await fs.rm(join(batch, entry.name), { force: true })
    }
  }
}

async function buildBatch(batchDirectory, inventoryFile) {
  const batch = resolve(batchDirectory)
  const verification = parseBetaVerification(
    await fs.readFile(join(batch, 'beta-verification.json'), 'utf8')
  )
  const version = verification.version

  // The legacy installer pair is still published for clients that cannot or do
  // not use the conventional manifest. It must stay byte-identical.
  const installer = await identifyFile(join(batch, verification.installer))
  if (installer.size !== verification.size || installer.sha256 !== verification.sha256) {
    throw new Error('旧版 Beta 安装包的长度或 SHA-256 与 beta-verification.json 不一致')
  }

  let base = null
  if (inventoryFile) {
    base = await readJson(resolve(inventoryFile))
    if (typeof base?.version !== 'string' || !isBetaVersion(base.version)) {
      throw new Error('基础应用清单缺少有效的 Beta 版本')
    }
    if (!isNewerVersion(version, base.version)) {
      throw new Error(`基础版本 ${base.version} 必须早于目标 ${version}`)
    }
    if (!SAFE_VERSION.test(base.version)) throw new Error('基础应用清单版本无效')
  }

  const unpacked = join(batch, 'win-unpacked')
  const notes = await readBetaNotes(batch)
  const built = await buildApplicationUpdate({
    unpacked,
    outDir: batch,
    version,
    notes,
    critical: false
  })

  let delta = null
  let preferredMissed = false
  if (base) {
    const targetApp = join(unpacked, 'resources', `app-${version}`)
    const archive = await buildAppDelta(base, targetApp, version)
    if (!Buffer.isBuffer(archive) || archive.length === 0) {
      throw new Error('差量包生成结果为空')
    }
    const name = deltaAssetName(base.version, version)
    if (archive.length >= built.payloadSize) {
      // The full app ZIP is the supported fallback; do not publish a delta that
      // costs more than it saves.
      console.error(
        `差量包 ${archive.length} 字节不小于完整应用包 ${built.payloadSize} 字节，已按完整应用包发布。`
      )
    } else {
      const path = join(batch, name)
      await writeAtomic(path, archive)
      const actual = await identifyFile(path)
      if (actual.size !== archive.length ||
          actual.sha256 !== createHash('sha256').update(archive).digest('hex')) {
        throw new Error('差量包写入后的长度或 SHA-256 不一致')
      }
      delta = { fromVersion: base.version, name, size: actual.size, sha256: actual.sha256 }
      built.manifest.delta = delta
      await writeUpdateManifest(batch, built.manifest)
      preferredMissed =
        version === '3.0.0-beta.12' && base.version === '3.0.0-beta.11' &&
        actual.size >= PREFERRED_DELTA_BYTES
    }
  }

  // Always leave the manifest as the single source of truth for what belongs to
  // this batch. A stale delta from a previous attempt must not be published.
  await removeStaleDeltas(batch, version, delta?.name)
  const assets = await verifyBetaLocalAssets(batch, version, built.electron)

  if (preferredMissed) {
    console.error(
      `3.0.0-beta.11 → 3.0.0-beta.12 差量包为 ${(delta.size / 1024).toFixed(1)} KiB，` +
        '超过 100 KiB 目标；已保留自然生成的较小差量。'
    )
  }

  const deltaText = delta
    ? ` · ${delta.name} ${(delta.size / 1024).toFixed(1)} KiB`
    : ' · 无差量包'
  console.log(
    `${version} · electron ${built.electron} · ${(built.payloadSize / 1024).toFixed(1)} KiB app ZIP` +
      `${deltaText} · ${Object.keys(assets).length} assets verified`
  )
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--inventory') {
    if (args.length !== 3) {
      throw new Error('用法：node scripts/build-beta-update.mjs --inventory <base-app-dir> <base-beta-version>')
    }
    await printInventory(args[1], args[2])
    return
  }
  if (args.length < 1 || args.length > 2 || args[0].startsWith('--')) {
    throw new Error(
      '用法：node scripts/build-beta-update.mjs <release-beta-batch-dir> [base-inventory-file]'
    )
  }
  await buildBatch(args[0], args[1])
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
