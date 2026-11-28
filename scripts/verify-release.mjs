import { createWriteStream, createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { matchesUpdateTransfer, parseUpdateManifest, payloadAssetName, STABLE_VERSION } from '../src/main/services/appUpdateManifest.ts'
import { identifyFile } from './release-assets.mjs'

const repo = 'KevinYuHere/KevinLauncher'
const parallel = 8

/** @param {string} url @param {Record<string, string>} [headers] @param {AbortSignal} [signal] */
async function download(url, headers = {}, signal, { attempts = 1, request = fetch } = {}) {
  const token = process.env.GH_TOKEN
  const authentication = token && new URL(url).hostname === 'api.github.com'
    ? { authorization: 'Bearer ' + token }
    : {}
  for (let attempt = 1; ; attempt++) {
    const response = await request(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'KevinLauncher', ...authentication, ...headers },
      signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])])
    })
    if (response.ok) return response
    if (attempt >= attempts || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error('HTTP ' + response.status + ' 下载失败')
    }
    await response.body?.cancel()
    await delay(250 * 2 ** (attempt - 1), undefined, { signal })
  }
}

export async function releasedAssets(tag = 'latest') {
  if (tag !== 'latest' && (!tag.startsWith('v') || !STABLE_VERSION.test(tag.slice(1)))) {
    throw new Error('请输入正式标签')
  }
  const path = tag === 'latest' ? 'latest' : 'tags/' + tag
  const response = await download('https://api.github.com/repos/' + repo + '/releases/' + path, {
    accept: 'application/vnd.github+json'
  })
  const release = await response.json()
  const version = release.tag_name?.slice(1)
  if (!STABLE_VERSION.test(version) || release.prerelease || release.draft ||
      tag !== 'latest' && release.tag_name !== tag) throw new Error('正式 Release 身份无效')
  const pick = name => {
    const asset = release.assets?.find(item => item.name === name)
    if (!asset || !Number.isSafeInteger(asset.id)) throw new Error('Release 缺少 ' + name)
    const direct = 'https://github.com/' + repo + '/releases/download/v' + version + '/' + name
    const api = 'https://api.github.com/repos/' + repo + '/releases/assets/' + asset.id
    return { url: process.env.GH_TOKEN ? api : direct, size: asset.size }
  }
  const manifest = parseUpdateManifest(await (await download(pick('update-manifest.json').url)).text(), version)
  if (!manifest.installerName) throw new Error('正式清单缺少安装包')
  const payload = pick(payloadAssetName(version))
  const installer = pick(manifest.installerName)
  if (payload.size !== manifest.payloadSize || installer.size !== manifest.installerSize) {
    throw new Error('GitHub 资产大小与更新清单不一致')
  }
  return { manifest, payload, installer }
}

async function downloadVerifiedAsset(asset, file, size, sha256, description, fetchFile) {
  const response = await fetchFile(asset.url)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx' }))
  const actual = await identifyFile(file)
  if (actual.size !== size || actual.sha256 !== sha256) {
    throw new Error(description + '校验失败')
  }
}

export async function downloadInstaller(release, file) {
  await downloadVerifiedAsset(release.installer, file, release.manifest.installerSize,
    release.manifest.installerSha256, '历史正式安装包', download)
}

export async function downloadPayload(release, file, request = fetch) {
  const fetchFixture = url => download(url, {}, undefined, { attempts: 3, request })
  await downloadVerifiedAsset(release.payload, file, release.manifest.payloadSize,
    release.manifest.payloadSha256, '历史正式应用载荷', fetchFixture)
}

export async function verifyRemotePayload(asset, manifest, dir, fetchRange = download) {
  if (!Number.isSafeInteger(manifest.payloadSize) || manifest.payloadSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.payloadSha256)) throw new Error('缺少更新包校验信息')
  const stage = await mkdtemp(join(dir, 'ranges-'))
  try {
    return await verifyRanges(asset, manifest, stage, fetchRange)
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function verifyRanges(asset, manifest, dir, fetchRange) {
  const controller = new AbortController()
  const count = Math.min(parallel, manifest.payloadSize)
  const files = Array.from({ length: count }, (_, index) => join(dir, 'part-' + index))
  const results = await Promise.allSettled(files.map(async (file, index) => {
    const start = Math.floor(manifest.payloadSize * index / count)
    const end = Math.floor(manifest.payloadSize * (index + 1) / count) - 1
    try {
      const response = await fetchRange(asset.url, { range: 'bytes=' + start + '-' + end }, controller.signal)
      if (!response.body || !matchesUpdateTransfer(response.status, response.headers, end - start + 1, {
        start, end: end + 1, size: manifest.payloadSize
      })) {
        await response.body?.cancel()
        throw new Error('分片 Content-Range 不匹配')
      }
      let length = 0
      await pipeline(Readable.fromWeb(response.body), async function* (input) {
        for await (const chunk of input) {
          length += chunk.length
          if (length > end - start + 1) throw new Error('响应超过预期分片长度')
          yield chunk
        }
      }, createWriteStream(file, { flags: 'wx' }), { signal: controller.signal })
      if (length !== end - start + 1) throw new Error('分片长度不匹配')
    } catch (error) {
      controller.abort(error)
      throw error
    }
  }))
  if (controller.signal.aborted) throw controller.signal.reason
  if (results.some(result => result.status === 'rejected')) throw new Error('分片下载失败')
  const assembled = join(dir, 'payload.zip')
  await pipeline(Readable.from((async function* () {
    for (const file of files) yield* createReadStream(file)
  })()), createWriteStream(assembled, { flags: 'wx' }))
  const actual = await identifyFile(assembled)
  if (actual.size !== manifest.payloadSize || actual.sha256 !== manifest.payloadSha256) {
    throw new Error('更新包 SHA-256 或长度不匹配')
  }
  return actual
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = await releasedAssets(process.argv[2])
  const dir = await mkdtemp(join(tmpdir(), 'verify-release-'))
  try {
    const payload = await verifyRemotePayload(release.payload, release.manifest, dir)
    console.log('v' + release.manifest.version + ' ' + payload.size + ' bytes · ' + payload.sha256)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
