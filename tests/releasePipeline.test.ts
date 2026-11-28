import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { assertCiRun, assertLocalReleaseBlockers } from '../scripts/release-source.mjs'
import { betaPackageMetadata, copyBetaBuildInputs } from '../scripts/package-test.mjs'
import { seedTrial } from '../scripts/seed-trial.mjs'
import { downloadPayload, verifyRemotePayload } from '../scripts/verify-release.mjs'
import { assetNames, mayBuildBatch, missingDraftAssets, verifyLocalAssets } from '../scripts/release-assets.mjs'

const temps: string[] = []
async function temp(): Promise<string> {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kl-release-tests-')))
  temps.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

test('Beta changes only the version in separate package and lock manifests', () => {
  const version = '3.0.0'
  const manifest = { name: 'kevin-launcher', version, dependencies: { electron: '44.11.6' } }
  const lock = {
    version,
    packages: {
      '': { name: manifest.name, version, dependencies: manifest.dependencies },
      'node_modules/electron': { version: '44.11.6' }
    }
  }
  const [beta, betaLock] = betaPackageMetadata(manifest, lock, undefined)
  expect(beta).toEqual({ ...manifest, version: '3.0.1-beta.1' })
  expect(betaLock).toEqual({
    ...lock,
    version: beta.version,
    packages: { ...lock.packages, '': { ...lock.packages[''], version: beta.version } }
  })
  expect(manifest.version).toBe(version)
  expect(lock.packages[''].version).toBe(version)
  expect(betaPackageMetadata(manifest, lock, '3.0.0-beta.1')[0].version).toBe('3.0.0-beta.1')
  expect(betaPackageMetadata(manifest, lock, '3.0.1-beta.12')[0].version).toBe('3.0.1-beta.12')
  expect(betaPackageMetadata(manifest, lock, '3.1.0-beta.1')[0].version).toBe('3.1.0-beta.1')
  expect(betaPackageMetadata(manifest, lock, '4.0.0-beta.1')[0].version).toBe('4.0.0-beta.1')
  for (const older of ['2.9.9-beta.1', '2.0.5-beta.1']) {
    expect(() => betaPackageMetadata(manifest, lock, older)).toThrow('主版本不能低于 3.0.0')
  }
  for (const malformed of ['3.0.0', '3.0.1', '3.0.0-beta.01', '3.0.0-rc.1']) {
    expect(() => betaPackageMetadata(manifest, lock, malformed)).toThrow('x.y.z-beta.n')
  }
  expect(() => betaPackageMetadata(manifest, { ...lock, version: '2.9.9' }, undefined)).toThrow('同一正式版本号')
})

test('Beta stages a source archive without Git and leaves out local-only configuration', async () => {
  const root = await temp()
  const source = join(root, 'staged')
  const inputs = ['scripts', 'src', 'resources', 'shell/out', 'tests']
  for (const input of inputs) await fs.mkdir(join(root, input), { recursive: true })
  const files = [
    'electron-builder.yml', 'electron.vite.config.ts', 'vitest.config.ts',
    'theme-policy.json', 'tsconfig.test.json', 'shell/out/main.js'
  ]
  const omitted = ['src/.env.local', 'scripts/verify.ps1', 'tests/integration.log', 'notes.md']
  for (const file of [...files, ...omitted]) await fs.writeFile(join(root, file), file)
  await copyBetaBuildInputs(root, source)
  for (const file of files) expect(await fs.readFile(join(source, file), 'utf8')).toBe(file)
  for (const file of omitted) await expect(fs.access(join(source, file))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('historical Windows fixtures verify the published application payload before extraction', async () => {
  const dir = await temp()
  const content = 'published application archive fixture'
  const release = {
    payload: { url: 'https://example.test/asset' },
    manifest: { payloadSize: Buffer.byteLength(content), payloadSha256: createHash('sha256').update(content).digest('hex') }
  }
  const file = join(dir, 'legacy-app.zip')
  await downloadPayload(release, file, async () => new Response(content))
  expect(await fs.readFile(file, 'utf8')).toBe(content)
  for (const [index, invalid] of [content.slice(1), 'x' + content.slice(1)].entries()) {
    let requests = 0
    await expect(downloadPayload(release, join(dir, 'invalid-' + index), async () => {
      requests++
      return new Response(invalid)
    })).rejects.toThrow('历史正式应用载荷校验失败')
    expect(requests).toBe(1)
  }
})

test('historical Windows payloads retry temporary HTTP errors at most twice', async () => {
  const dir = await temp()
  const content = 'published archive'
  const release = {
    payload: { url: 'https://example.test/asset' },
    manifest: { payloadSize: Buffer.byteLength(content), payloadSha256: createHash('sha256').update(content).digest('hex') }
  }
  const file = join(dir, 'recovered.zip')
  let attempts = 0
  await downloadPayload(release, file, async () => {
    attempts++
    return attempts < 3 ? new Response('temporarily unavailable', { status: 503 }) : new Response(content)
  })
  expect(attempts).toBe(3)
  expect(await fs.readFile(file, 'utf8')).toBe(content)
  for (const [status, expected] of [[503, 3], [404, 1]]) {
    const missing = join(dir, 'missing-' + status + '.zip')
    attempts = 0
    await expect(downloadPayload(release, missing, async () => {
      attempts++
      return new Response('not available', { status })
    })).rejects.toThrow('HTTP ' + status)
    expect(attempts).toBe(expected)
    await expect(fs.access(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('official release uses only the exact successful main push CI', () => {
  const head = '1234567890abcdef1234567890abcdef12345678'
  const previous = 'abcdef1234567890abcdef1234567890abcdef12'
  const ci = {
    head_sha: head, head_branch: 'main', event: 'push', conclusion: 'success', path: '.github/workflows/ci.yml'
  }
  expect(assertCiRun(ci, head, 'main')).toBe(true)
  expect(assertCiRun(ci, previous, 'main')).toBe(false)
  expect(assertCiRun({ ...ci, event: 'pull_request' }, head, 'main')).toBe(false)
  expect(assertCiRun({ ...ci, conclusion: 'failure' }, head, 'main')).toBe(false)
})

test('release:prepare skips an absent local AGENTS.md but blocks on present checklist items', async () => {
  const root = await temp()
  const file = join(root, 'AGENTS.md')
  expect(assertLocalReleaseBlockers(file)).toBe(false)
  await fs.writeFile(file, '# Project rules\n\n## 13. 发版阻断项\n\n### 待修复\n\n- [ ] 未完成\n')
  expect(() => assertLocalReleaseBlockers(file)).toThrow('发版阻断项')
  await fs.writeFile(file, '# Project rules\n\n## 13. 发版阻断项\n\n### 待修复\n\n暂无。\n\n### 已修复\n\n- [x] 已完成\n')
  expect(assertLocalReleaseBlockers(file)).toBe(true)
  await fs.writeFile(file, '# Project rules\n')
  expect(() => assertLocalReleaseBlockers(file)).toThrow('发版阻断项')
})

test('only an unbuilt push can build and retries never replace conflicting or published assets', () => {
  expect(mayBuildBatch(null, false)).toBe(true)
  expect(mayBuildBatch({ expired: false }, false)).toBe(false)
  expect(() => mayBuildBatch(null, true)).toThrow('不能重新构建')
  expect(() => mayBuildBatch({ expired: true }, true)).toThrow('不能重新构建')
  const marker = '<!-- source=sha run=42 -->'
  const files = { 'installer.exe': { sha256: 'a'.repeat(64), size: 100 },
    'manifest.json': { sha256: 'b'.repeat(64), size: 50 } }
  const asset = { name: 'installer.exe', digest: 'sha256:' + 'a'.repeat(64), size: 100, state: 'uploaded' }
  const draft = { draft: true, prerelease: false, body: marker, assets: [asset] }
  expect(missingDraftAssets(draft, files, marker)).toEqual(['manifest.json'])
  expect(() => missingDraftAssets({ ...draft, draft: false }, files, marker)).toThrow('拒绝修改')
  expect(() => missingDraftAssets({ ...draft, body: 'different run' }, files, marker)).toThrow('批次不符')
  expect(() => missingDraftAssets({
    ...draft, assets: [{ ...asset, digest: 'sha256:' + 'd'.repeat(64) }]
  }, files, marker)).toThrow('远端资产冲突')
})

test('an incomplete trial data copy leaves the existing trial and source intact', async () => {
  const base = await temp()
  const source = join(base, 'source')
  const trial = join(base, 'trial')
  await fs.mkdir(join(source, 'icons'), { recursive: true })
  const sourceConfig = '{"apps":[{"id":"new"}]}'
  const previous = '{"apps":[{"id":"previous"}]}'
  await fs.writeFile(join(source, 'config.json'), sourceConfig)
  await fs.writeFile(join(source, 'icons', 'icon.png'), 'file')
  await fs.writeFile(join(source, 'auth.json'), 'not copied')
  await fs.mkdir(join(trial, 'data'), { recursive: true })
  await fs.writeFile(join(trial, 'data', 'config.json'), previous)
  await expect(seedTrial(source, trial, {
    replace: true,
    beforeFile: async file => { if (file?.endsWith('icon.png')) throw new Error('read failed') }
  })).rejects.toThrow('read failed')
  expect(await fs.readFile(join(trial, 'data', 'config.json'), 'utf8')).toBe(previous)
  expect(await fs.readFile(join(source, 'config.json'), 'utf8')).toBe(sourceConfig)
  expect(await fs.readdir(trial)).toEqual(['data'])
  await seedTrial(source, trial, { replace: true })
  expect(await fs.readFile(join(trial, 'data', 'config.json'), 'utf8')).toBe(sourceConfig)
  expect(await fs.stat(join(trial, 'data', 'auth.json')).catch(() => null)).toBeNull()
})

test.each([
  [{ iconFile: 'missing.png' }, 'icons/missing.png'],
  [{ wallpapers: [{ file: 'missing.png' }] }, 'bg/missing.png'],
  [{ backgroundFile: 'legacy.png' }, 'bg/legacy.png']
])('a missing trial media reference preserves the existing seeded profile', async (app, file) => {
  const base = await temp()
  const source = join(base, 'source')
  const trial = join(base, 'trial')
  await fs.mkdir(source)
  await fs.mkdir(join(trial, 'data'), { recursive: true })
  const prior = '{"apps":[]}'
  await fs.writeFile(join(trial, 'data', 'config.json'), prior)
  await fs.writeFile(join(source, 'config.json'), JSON.stringify({ apps: [app] }))

  await expect(seedTrial(source, trial, { replace: true })).rejects.toThrow('缺少引用的媒体：' + file)
  expect(await fs.readFile(join(trial, 'data', 'config.json'), 'utf8')).toBe(prior)
  expect(await fs.readdir(trial)).toEqual(['data'])
})

test('release validation checks both required hashes and cleans up failed range downloads', async () => {
  const dir = await temp()
  const bytes = Buffer.from('0'.repeat(1024 * 1024) + 'abcdefgh')
  const digest = (file: Uint8Array): string => createHash('sha256').update(file).digest('hex')
  const version = '2.0.6'
  const electron = '44.11.6'
  const [installer, payload, manifestFile] = assetNames(version)
  const installerFile = Buffer.from('installer bytes')
  const manifest = {
    version, electron, appSize: bytes.length + 100,
    payloadSize: bytes.length, payloadSha256: digest(bytes), installerName: installer,
    installerSize: installerFile.length, installerUnpackedSize: 4096,
    installerSha256: digest(installerFile), critical: false,
    compatibility: { shellProtocol: 2, installProtocol: 1, dataSchema: 1, hostSha256: 'a'.repeat(64) }
  }
  await fs.writeFile(join(dir, installer), installerFile)
  await fs.writeFile(join(dir, payload), bytes)
  await fs.writeFile(join(dir, manifestFile), JSON.stringify(manifest))
  await expect(verifyLocalAssets(dir, version, electron)).resolves.toMatchObject({
    [payload]: { size: bytes.length, sha256: manifest.payloadSha256 }
  })
  await fs.writeFile(join(dir, installer), 'unexpected')
  await expect(verifyLocalAssets(dir, version, electron)).rejects.toThrow('SHA-256')
  const workspace = await temp()
  const asset = { url: 'http://localhost/test.zip', size: bytes.length }
  const fetchRange = async (_url: string, { range }: Record<string, string> = {}) => {
    const [start, end] = range.slice('bytes='.length).split('-').map(Number)
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206, headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length }
    })
  }
  await expect(verifyRemotePayload(asset, manifest, workspace, fetchRange)).resolves.toMatchObject({
    size: bytes.length, sha256: manifest.payloadSha256
  })
  await expect(verifyRemotePayload(asset, manifest, workspace, async () => new Response('bad')))
    .rejects.toThrow('Content-Range')
  expect(await fs.readdir(workspace)).toEqual([])
})
