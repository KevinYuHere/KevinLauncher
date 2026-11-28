import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deltaAssetName,
  installerAssetName,
  isBetaVersion,
  isPositiveFileSize,
  isSha256,
  parseBetaVerification,
  parseUpdateManifest,
  payloadAssetName,
  SAFE_VERSION,
  STABLE_VERSION
} from '../src/main/services/appUpdateManifest.ts'

/** Assets of a stable release. Kept unchanged for the official workflow. */
export function assetNames(version) {
  return [installerAssetName(version), payloadAssetName(version), 'update-manifest.json']
}

/**
 * Assets published next to a verified Beta. The standard manifest and full
 * versioned app ZIP are what a released 2.0.5 client understands; the installer
 * and `beta-verification.json` remain for older installer-only Beta clients.
 */
export function betaAssetNames(version, deltaName) {
  if (!isBetaVersion(version)) throw new Error('Beta 发布产物必须使用 Beta 版本号')
  return [
    installerAssetName(version),
    payloadAssetName(version),
    'update-manifest.json',
    'beta-verification.json',
    ...(deltaName ? [deltaName] : [])
  ]
}

export async function identifyFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error(`不是常规文件：${path}`)
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(path)) sha256.update(chunk)
  return { size: stat.size, sha256: sha256.digest('hex') }
}

/** Strict official-release validation. Do not relax for Beta support. */
export async function verifyLocalAssets(dir, version, electron) {
  if (!STABLE_VERSION.test(version)) throw new Error('发布产物必须使用正式版本号')
  const names = assetNames(version)
  const manifest = parseUpdateManifest(await readFile(join(dir, names[2]), 'utf8'), version)
  if (!manifest.installerName || !manifest.installerUnpackedSize || !manifest.compatibility || manifest.electron !== electron) {
    throw new Error('更新清单缺少完整安装包、兼容信息或准确 Electron 版本')
  }
  const [installer, payload, manifestFile] = await Promise.all(
    names.map(name => identifyFile(join(dir, name)))
  )
  if (installer.size !== manifest.installerSize || installer.sha256 !== manifest.installerSha256 ||
      payload.size !== manifest.payloadSize || payload.sha256 !== manifest.payloadSha256) {
    throw new Error('产物长度或 SHA-256 与更新清单不一致')
  }
  return Object.fromEntries(names.map((name, index) => [name, [installer, payload, manifestFile][index]]))
}

/**
 * Validates the complete Beta asset set. The standard manifest must describe
 * the same full payload, Electron runtime and legacy installer as the files on
 * disk, and an advertised delta must match its exact source version and be
 * strictly smaller than the full app ZIP.
 */
export async function verifyBetaLocalAssets(dir, version, electron) {
  if (!isBetaVersion(version)) throw new Error('Beta 发布产物必须使用 Beta 版本号')
  const verification = parseBetaVerification(
    await readFile(join(dir, 'beta-verification.json'), 'utf8'),
    version
  )
  const manifestText = await readFile(join(dir, 'update-manifest.json'), 'utf8')
  const manifest = parseUpdateManifest(manifestText, version)
  const raw = JSON.parse(manifestText)
  if (manifest.electron !== electron) {
    throw new Error('更新清单的运行库版本与实际运行库不符')
  }
  if (!manifest.compatibility) throw new Error('Beta 更新清单缺少兼容信息')
  if (!manifest.installerName || !manifest.installerUnpackedSize ||
      manifest.installerSize !== verification.size || manifest.installerSha256 !== verification.sha256) {
    throw new Error('Beta 更新清单与旧版验证清单的安装包信息不一致')
  }

  let deltaName = null
  if (raw.delta != null) {
    if (!raw.delta || typeof raw.delta !== 'object' || Array.isArray(raw.delta) ||
        Object.keys(raw.delta).sort().join(',') !== 'fromVersion,name,sha256,size') {
      throw new Error('更新清单的差量包信息无效')
    }
    const { fromVersion, name, size, sha256 } = raw.delta
    if (typeof fromVersion !== 'string' || !SAFE_VERSION.test(fromVersion) || fromVersion === version ||
        !isPositiveFileSize(size) || !isSha256(sha256) || typeof name !== 'string') {
      throw new Error('更新清单的差量包信息无效')
    }
    if (name !== deltaAssetName(fromVersion, version)) {
      throw new Error('更新清单的差量包文件名与源版本不符')
    }
    if (size >= manifest.payloadSize) throw new Error('差量包未小于完整应用包')
    deltaName = name
  }

  const names = betaAssetNames(version, deltaName)
  const assets = Object.fromEntries(await Promise.all(names.map(async name => [
    name, await identifyFile(join(dir, name))
  ])))
  const installer = assets[verification.installer]
  const payload = assets[payloadAssetName(version)]
  if (!installer || installer.size !== manifest.installerSize || installer.sha256 !== manifest.installerSha256) {
    throw new Error('Beta 安装包长度或 SHA-256 与更新清单不一致')
  }
  if (payload.size !== manifest.payloadSize || payload.sha256 !== manifest.payloadSha256) {
    throw new Error('Beta 应用包长度或 SHA-256 与更新清单不一致')
  }
  if (deltaName) {
    const delta = assets[deltaName]
    if (delta.size !== raw.delta.size || delta.sha256 !== String(raw.delta.sha256).toLowerCase()) {
      throw new Error('Beta 差量包长度或 SHA-256 与更新清单不一致')
    }
  }
  return assets
}

export function mayBuildBatch(artifact, previouslyFrozen) {
  if (artifact?.expired || previouslyFrozen && !artifact) {
    throw new Error('此前冻结的正式批次已不可用，不能重新构建')
  }
  return !artifact
}

export function missingDraftAssets(release, assets, marker) {
  if (!release || release.prerelease || !release.body?.includes(marker)) {
    throw new Error('同版本发布批次不符，拒绝改变远端资产')
  }
  for (const asset of release.assets) {
    const known = assets[asset.name]
    if (!known || asset.state !== 'uploaded' || asset.size !== known.size ||
        asset.digest !== 'sha256:' + known.sha256) {
      throw new Error('远端资产冲突：' + asset.name + '，请准备新版本')
    }
  }
  const missing = Object.keys(assets).filter(name => !release.assets.some(asset => asset.name === name))
  if (!release.draft && missing.length) throw new Error('已发布版本缺少产物，拒绝修改')
  return missing
}
