import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  installerAssetName, parseUpdateManifest, payloadAssetName, STABLE_VERSION
} from '../src/main/services/appUpdateManifest.ts'

export function assetNames(version) {
  return [installerAssetName(version), payloadAssetName(version), 'update-manifest.json']
}

export async function identifyFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error(`不是常规文件：${path}`)
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(path)) sha256.update(chunk)
  return { size: stat.size, sha256: sha256.digest('hex') }
}

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
