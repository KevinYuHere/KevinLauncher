import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { completedCodexReview, assertCiRun } from '../scripts/release-source.mjs'
import { seedTrial } from '../scripts/seed-trial.mjs'
import { verifyRemotePayload } from '../scripts/verify-release.mjs'
import { assetNames, mayBuildBatch, missingDraftAssets, verifyLocalAssets } from '../scripts/release-assets.mjs'

const temps: string[] = []
async function temp(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'kl-release-tests-'))
  temps.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

test('requires a completed trusted current-head review separately from successful exact push CI', () => {
  const head = '1234567890abcdef1234567890abcdef12345678'
  const previous = 'abcdef1234567890abcdef1234567890abcdef12'
  const merged = '2026-11-25T01:00:00Z'
  const time = '2026-11-25T00:30:00Z'
  const bot = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }
  const summary = {
    user: bot, created_at: time, updated_at: time, id: 7, html_url: 'https://example.test/review/7',
    body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \x60" + head.slice(0, 10) + '\x60'
  }
  expect(completedCodexReview([], [summary], head, merged)?.id).toBe(7)
  expect(completedCodexReview([], [summary], previous, merged)).toBeUndefined()
  expect(completedCodexReview([], [{ ...summary, user: { ...bot, type: 'User' } }], head, merged)).toBeUndefined()
  expect(completedCodexReview([], [{ ...summary, body: 'Code Review / Completed' }], head, merged)).toBeUndefined()
  expect(completedCodexReview([{
    user: bot, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-11-25T00:40:00Z'
  }], [summary], head, merged)).toBeUndefined()
  const ci = {
    head_sha: head, head_branch: 'main', event: 'push', conclusion: 'success', path: '.github/workflows/ci.yml'
  }
  expect(assertCiRun(ci, head, 'main')).toBe(true)
  expect(assertCiRun(ci, previous, 'main')).toBe(false)
  expect(assertCiRun({ ...ci, event: 'pull_request' }, head, 'main')).toBe(false)
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
