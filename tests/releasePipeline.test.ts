import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { completedCodexReview, assertCiRun } from '../scripts/release-source.mjs'
import { betaPackageMetadata, copyBetaBuildInputs } from '../scripts/package-test.mjs'
import { seedTrial } from '../scripts/seed-trial.mjs'
import { verifyRemotePayload } from '../scripts/verify-release.mjs'
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
  const version = '2.0.5'
  const manifest = { name: 'kevin-launcher', version, dependencies: { electron: '44.11.6' } }
  const lock = {
    version,
    packages: {
      '': { name: manifest.name, version, dependencies: manifest.dependencies },
      'node_modules/electron': { version: '44.11.6' }
    }
  }
  const [beta, betaLock] = betaPackageMetadata(manifest, lock, undefined)
  expect(beta).toEqual({ ...manifest, version: '2.0.6-beta.1' })
  expect(betaLock).toEqual({
    ...lock,
    version: beta.version,
    packages: { ...lock.packages, '': { ...lock.packages[''], version: beta.version } }
  })
  expect(manifest.version).toBe(version)
  expect(lock.packages[''].version).toBe(version)
  expect(betaPackageMetadata(manifest, lock, '2.0.6-beta.12')[0].version).toBe('2.0.6-beta.12')
  expect(betaPackageMetadata(manifest, lock, '2.1.0-beta.1')[0].version).toBe('2.1.0-beta.1')
  for (const invalid of ['2.0.5-beta.1', '2.0.6', '2.0.6-beta.01', '2.0.7-rc.1']) {
    expect(() => betaPackageMetadata(manifest, lock, invalid)).toThrow('高于 2.0.5 的 Beta 版本号')
  }
  expect(() => betaPackageMetadata(manifest, { ...lock, version: '2.0.4' }, undefined)).toThrow('同一正式版本号')
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

test('simple review text cannot substitute for both scoped reviews or exact push CI', () => {
  const head = '1234567890abcdef1234567890abcdef12345678'
  const previous = 'abcdef1234567890abcdef1234567890abcdef12'
  const merged = '2026-11-25T01:00:00Z'
  const time = '2026-11-25T00:30:00Z'
  const bot = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }
  const issue = 'https://api.github.com/repos/KevinYuHere/KevinLauncher/issues/3'
  const summary = {
    user: bot, created_at: time, updated_at: time, id: 7, html_url: 'https://example.test/review/7', issue_url: issue,
    body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \x60" + head.slice(0, 10) + '\x60'
  }
  expect(completedCodexReview([], [summary], head, merged, issue)).toBeUndefined()
  const ci = {
    head_sha: head, head_branch: 'main', event: 'push', conclusion: 'success', path: '.github/workflows/ci.yml'
  }
  expect(assertCiRun(ci, head, 'main')).toBe(true)
  expect(assertCiRun(ci, previous, 'main')).toBe(false)
  expect(assertCiRun({ ...ci, event: 'pull_request' }, head, 'main')).toBe(false)
})

test('uses the latest full-commit Codex status issued on the reviewed pull request', () => {
  const head = '1234567890abcdef1234567890abcdef12345678'
  const other = 'abcdef1234567890abcdef1234567890abcdef12'
  const issue = 'https://api.github.com/repos/KevinYuHere/KevinLauncher/issues/3'
  const merged = '2026-11-25T11:00:00Z'
  const summary = (overrides = {}, securityOverrides = {}) => ({
    id: 10, html_url: 'https://github.com/KevinYuHere/KevinLauncher/pull/3#issuecomment-10', issue_url: issue,
    created_at: '2026-11-25T10:35:17Z', updated_at: '2026-11-25T10:42:00Z',
    user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
    performed_via_github_app: { slug: 'chatgpt-codex-connector' },
    body: '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ' + JSON.stringify({
      code_review: {
        commit_sha: head, has_any_findings: true, has_unresolved_findings: false, status: 'completed', ...overrides
      },
      security_review: {
        commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status: 'completed', ...securityOverrides
      }
    }) + ' -->\n<!-- codex-security-review:v1 ' + JSON.stringify({
      blockingSeverityThreshold: 'P0', headSha: head, mergeGateEnabled: false,
      pullRequestNumber: 3, repository: 'KevinYuHere/KevinLauncher', status: 'completed'
    }) + ' -->'
  })
  const clean = summary()
  const verdict = (comments: ReturnType<typeof summary>[]) => completedCodexReview([], comments, head, merged, issue)
  expect(verdict([clean])).toMatchObject({ reviewed: head, submittedAt: clean.updated_at })
  expect(verdict([summary({ commit_sha: other })])).toBeUndefined()
  expect(verdict([summary({ commit_sha: head.slice(0, 12) })])).toBeUndefined()
  expect(verdict([summary({ status: 'in_progress' })])).toBeUndefined()
  expect(verdict([{ ...clean, user: { ...clean.user, type: 'User' } }])).toBeUndefined()
  expect(verdict([summary({}, { status: 'running' })])).toBeUndefined()
  expect(verdict([summary({}, { commit_sha: other })])).toBeUndefined()
  expect(verdict([summary({}, { has_any_findings: true, has_unresolved_findings: true })])).toBeUndefined()
  expect(verdict([{ ...clean, body: clean.body.replace('"pullRequestNumber":3', '"pullRequestNumber":4') }])).toBeUndefined()
  expect(verdict([{ ...clean, body: clean.body + '\n### Security findings\n#### Blocking findings (1)' }])).toBeUndefined()
  expect(verdict([{ ...clean, issue_url: issue + '0' }])).toBeUndefined()
  expect(verdict([{ ...clean, performed_via_github_app: { slug: 'other-reviewer' } }])).toBeUndefined()
  expect(verdict([{ ...clean, updated_at: '2026-11-25T11:01:00Z' }])).toBeUndefined()
  expect(verdict([clean, {
    ...summary({ has_unresolved_findings: true }), id: 11, updated_at: '2026-11-25T10:43:00Z'
  }])).toBeUndefined()
  expect(verdict([clean, {
    ...clean, body: '<!-- codex-review-state:v1 malformed -->', id: 11, updated_at: '2026-11-25T10:43:00Z'
  }])).toBeUndefined()
  expect(completedCodexReview([{
    user: clean.user, commit_id: head, state: 'COMMENTED', submitted_at: '2026-11-25T10:43:00Z'
  }], [clean], head, merged, issue)).toBeUndefined()

  const findingId = 4694576796
  const archived = {
    ...clean,
    body: clean.body + '\n### Security findings\n\n#### Advisory findings (1)\n\n' +
      '- 🟡 [Previous advisory](https://github.com/KevinYuHere/KevinLauncher/pull/3#discussion_r' + findingId + ') · **Medium**\n\n<details>'
  }
  const thread = (isResolved: boolean, original = other, author = 'chatgpt-codex-connector') => ({
    isResolved,
    comments: { nodes: [{ databaseId: findingId, author: { __typename: 'Bot', login: author },
      originalCommit: { oid: original }, body: '<!-- codex-security-review-finding:v1 -->\nPrevious advisory' }] }
  })
  const review = (comment: typeof clean, threads: ReturnType<typeof thread>[] = []) =>
    completedCodexReview([], [comment], head, merged, issue, threads)
  expect(review(archived, [thread(true)])).toMatchObject({ reviewed: head })
  expect(review(archived)).toBeUndefined()
  expect(review(archived, [thread(false)])).toBeUndefined()
  expect(review(archived, [thread(true, head)])).toBeUndefined()
  expect(review(archived, [thread(true, other, 'other-bot')])).toBeUndefined()
  expect(review({ ...archived, body: archived.body.replace('KevinYuHere/KevinLauncher/pull/3#discussion',
    'AnotherOwner/AnotherRepository/pull/3#discussion') }, [thread(true)])).toBeUndefined()
  expect(review(clean, [thread(false, head)])).toBeUndefined()
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
