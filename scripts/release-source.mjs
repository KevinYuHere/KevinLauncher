import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { STABLE_VERSION } from '../src/main/services/appUpdateManifest.ts'

export const artifactName = sha => 'official-release-' + sha

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
}

export function readReleaseVersion() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const version = pkg.version
  if (!STABLE_VERSION.test(version) || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package.json 和 package-lock.json 必须使用同一正式版本号')
  }
  const electron = pkg.devDependencies.electron
  if (electron !== lock.packages?.['node_modules/electron']?.version || !STABLE_VERSION.test(electron)) {
    throw new Error('Electron 必须固定到锁文件中的具体正式版本')
  }
  execFileSync(process.execPath, ['scripts/extract-changelog.mjs', version], { stdio: 'pipe' })
  if (existsSync('theme-policy.json')) {
    if (JSON.parse(readFileSync('theme-policy.json', 'utf8'))?.version !== version) {
      throw new Error('theme-policy.json 必须属于本次正式版本')
    }
    git('ls-files', '--error-unmatch', 'theme-policy.json')
  }
  return { version, tag: 'v' + version, electron }
}

function repository() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('缺少 GitHub Actions 仓库')
  return repo
}

async function githubRequest(url, options) {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('缺少 GitHub Actions 访问上下文')
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...options.headers
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error('GitHub API ' + new URL(url).pathname + ' 返回 HTTP ' + response.status)
  if (response.status === 204) return undefined
  return await response.json()
}

export async function github(path, options = {}) {
  return githubRequest('https://api.github.com/repos/' + repository() + path, options)
}

export async function pages(path, key) {
  const all = []
  const delimiter = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= 20; page++) {
    const response = await github(path + delimiter + 'per_page=100&page=' + page)
    const entries = key ? response[key] : response
    if (!Array.isArray(entries)) throw new Error('GitHub API 分页内容无效')
    all.push(...entries)
    if (entries.length < 100) return all
  }
  throw new Error('GitHub API 分页超出校验限制')
}

export async function assertTag(tag, sha) {
  const ref = await github('/git/ref/tags/' + encodeURIComponent(tag))
  let object = ref.object
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    object = (await github('/git/tags/' + object.sha)).object
  }
  if (object.type !== 'commit' || object.sha !== sha) throw new Error('GitHub 正式标签指向已改变')
}

export function assertCiRun(run, sha, branch) {
  return run.head_sha === sha && run.head_branch === branch &&
    run.event === 'push' && run.conclusion === 'success' && run.path === '.github/workflows/ci.yml'
}

// A release binds only to the tag, its main ancestry, and the exact main push CI.
// Review and the ignored AGENTS.md blocker check stay local.
async function sourceEvidence(version) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const sha = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  const { GITHUB_EVENT_NAME: kind, GITHUB_REF: ref, GITHUB_SHA: workflowSha } = process.env
  if (ref !== 'refs/tags/' + version.tag || git('rev-parse', workflowSha + '^{commit}') !== sha ||
      !(kind === 'push' && event.created === true && !event.deleted || kind === 'workflow_dispatch')) {
    throw new Error('正式发布必须由已存在的正式标签 push 创建')
  }
  await assertTag(version.tag, sha)
  const main = await github('/branches/main')
  try {
    git('merge-base', '--is-ancestor', sha, main.commit.sha)
  } catch {
    throw new Error('正式标签提交必须包含在 main 中')
  }
  const ciRuns = await pages('/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=' + sha, 'workflow_runs')
  const exactCi = ciRuns.find(run => assertCiRun(run, sha, 'main'))
  if (!exactCi) throw new Error('标签准确提交尚未通过 main push 的 CI')
  return { ...version, sha, tree, exactCi: exactCi.id }
}

// AGENTS.md is intentionally untracked, so a clean checkout lacks it. Only a
// file that actually exists locally participates in the release blocker check.
export function assertLocalReleaseBlockers(file = 'AGENTS.md') {
  if (!existsSync(file)) return false
  const instructions = readFileSync(file, 'utf8')
  const blockers = instructions.split(/^## 13\./m)[1]?.split(/^## /m)[0] ?? ''
  if (!blockers || /^- \[ \]/m.test(blockers)) throw new Error('AGENTS.md 发版阻断项仍待修复或验证')
  return true
}

function prepare() {
  const version = readReleaseVersion()
  if (git('status', '--porcelain')) throw new Error('正式发布准备要求工作区干净')
  if (!assertLocalReleaseBlockers()) console.log('未找到本地 AGENTS.md，跳过本地发版阻断项检查')
  const sha = git('rev-parse', 'HEAD')
  if (git('tag', '--list', version.tag)) throw new Error('这个版本已使用，不能重新发布')
  console.log(JSON.stringify({ ...version, sha, tree: git('rev-parse', 'HEAD^{tree}') }, null, 2))
}

async function gate() {
  const evidence = await sourceEvidence(readReleaseVersion())
  const file = process.argv[3]
  if (!file) throw new Error('缺少发布证据输出路径')
  writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
  for (const [key, value] of Object.entries({
    version: evidence.version, tag: evidence.tag, sha: evidence.sha, electron: evidence.electron,
    artifact: artifactName(evidence.sha)
  })) appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'prepare') prepare()
  else if (process.argv[2] === 'gate') await gate()
  else throw new Error('预期子命令 prepare 或 gate')
}
