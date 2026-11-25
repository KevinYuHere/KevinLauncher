import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { STABLE_VERSION } from '../src/main/services/appUpdateManifest.ts'

const shaPattern = /^[0-9a-f]{40}$/
const codexLogin = 'chatgpt-codex-connector[bot]'
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

/** @param {string} [issueUrl] */
export function completedCodexReview(reviews, comments, sha, mergedAt, issueUrl) {
  const beforeMerge = time => Date.parse(time) <= Date.parse(mergedAt)
  const trusted = item => item.user?.login === codexLogin &&
    item.user.type === 'Bot' &&
    (!item.performed_via_github_app || item.performed_via_github_app.slug === 'chatgpt-codex-connector')
  const trustedComments = comments.filter(comment => trusted(comment) &&
    (!issueUrl || comment.issue_url === issueUrl))
  const summaries = trustedComments.flatMap(comment => {
    const data = (comment.body ?? '').match(/<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/)?.[1]
    if (data === undefined) return []
    let state
    try { state = JSON.parse(data)?.code_review } catch { /* A malformed current state cannot authorize release. */ }
    return [{ comment, state }]
  }).sort((a, b) => Date.parse(b.comment.updated_at) - Date.parse(a.comment.updated_at) || b.comment.id - a.comment.id)
  const latest = summaries[0]
  if (latest) {
    const { comment, state } = latest
    if (state?.commit_sha !== sha || !shaPattern.test(state.commit_sha) || state.status !== 'completed' ||
        typeof state.has_any_findings !== 'boolean' || state.has_unresolved_findings !== false ||
        !beforeMerge(comment.created_at) || !beforeMerge(comment.updated_at)) return undefined
    if (reviews.some(review => trusted(review) && review.commit_id === sha &&
        ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state) &&
        Date.parse(review.submitted_at) > Date.parse(comment.updated_at))) return undefined
    return { id: comment.id, url: comment.html_url, submittedAt: comment.updated_at, reviewed: state.commit_sha }
  }
  const clean = trustedComments.flatMap(comment => {
    if (!beforeMerge(comment.created_at) || !beforeMerge(comment.updated_at)) return []
    if (!/^Codex Review:\s+Didn't find any major issues\b/i.test(comment.body ?? '')) return []
    const reviewed = (comment.body ?? '').match(/(?:\*\*)?Reviewed commit:(?:\*\*)?\s*\x60([a-f0-9]{10,40})\x60/i)?.[1]
    if (!reviewed || !sha.startsWith(reviewed.toLowerCase())) return []
    return [{ id: comment.id, url: comment.html_url, submittedAt: comment.created_at, reviewed }]
  })
  const approvals = reviews.filter(review => trusted(review) && review.state === 'APPROVED' &&
    review.commit_id === sha && beforeMerge(review.submitted_at))
    .map(review => ({ id: review.id, url: review.html_url, submittedAt: review.submitted_at, reviewed: review.commit_id }))
  const verdict = [...clean, ...approvals].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0]
  const hasLaterFindings = reviews.some(review => trusted(review) && review.commit_id === sha &&
    ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state) && beforeMerge(review.submitted_at) &&
    Date.parse(review.submitted_at) >= Date.parse(verdict?.submittedAt))
  return hasLaterFindings ? undefined : verdict
}

export async function github(path, options = {}) {
  const token = process.env.GH_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('缺少 GitHub Actions 访问上下文')
  const response = await fetch('https://api.github.com/repos/' + repo + path, {
    ...options,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...options.headers
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error('GitHub API ' + path + ' 返回 HTTP ' + response.status)
  if (response.status === 204) return undefined
  return await response.json()
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
  const repo = process.env.GITHUB_REPOSITORY
  const main = await github('/branches/main')
  git('merge-base', '--is-ancestor', sha, main.commit.sha)
  const base = git('rev-parse', sha + '^1')
  const linked = await pages('/commits/' + sha + '/pulls')
  const prs = linked.filter(pr => pr.base?.ref === 'main' && pr.base.repo?.full_name === repo)
  const ciRuns = await pages('/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=' + sha, 'workflow_runs')
  const exactCi = ciRuns.find(run => assertCiRun(run, sha, 'main'))
  if (!exactCi) throw new Error('标签准确提交尚未通过 main push 的 CI')

  for (const item of prs) {
    const pr = await github('/pulls/' + item.number)
    const head = pr.head?.sha
    if (!pr.merged_at || pr.merge_commit_sha !== sha || !shaPattern.test(head ?? '') ||
        pr.head.repo?.full_name !== repo) continue
    // A release PR must have brought in the current main base before review.
    git('fetch', '--no-tags', 'origin', 'refs/pull/' + pr.number + '/head')
    if (git('rev-parse', 'FETCH_HEAD') !== head || git('merge-base', base, head) !== base ||
        git('rev-parse', head + '^{tree}') !== tree) continue
    const [reviews, comments, priorCiRuns] = await Promise.all([
      pages('/pulls/' + pr.number + '/reviews'),
      pages('/issues/' + pr.number + '/comments'),
      pages('/actions/workflows/ci.yml/runs?event=pull_request&head_sha=' + head, 'workflow_runs')
    ])
    const issueUrl = 'https://api.github.com/repos/' + repo + '/issues/' + pr.number
    const review = completedCodexReview(reviews, comments, head, pr.merged_at, issueUrl)
    if (!review) continue
    const resolvedReview = await github('/commits/' + review.reviewed)
    if (resolvedReview.sha !== head) continue
    const prCi = priorCiRuns.find(run => run.head_sha === head && run.event === 'pull_request' &&
      run.path === '.github/workflows/ci.yml' && run.conclusion === 'success' &&
      run.pull_requests?.some(link => link.number === pr.number &&
        link.head?.sha === head && link.base?.sha === base))
    if (!prCi || Date.parse(prCi.created_at) > Date.parse(review.submittedAt)) continue
    return { ...version, sha, tree, head, base, pr: pr.number, review, prCi: prCi.id, exactCi: exactCi.id }
  }
  throw new Error('缺少同一 PR 源码树、合并基线和提交上的 Codex 审阅及 CI')
}

function prepare() {
  const version = readReleaseVersion()
  if (git('status', '--porcelain')) throw new Error('正式发布准备要求工作区干净')
  const instructions = readFileSync('AGENTS.md', 'utf8')
  const blockers = instructions.split(/^## 13\./m)[1]?.split(/^## /m)[0] ?? ''
  if (!blockers || /^- \[ \]/m.test(blockers)) throw new Error('AGENTS.md 发版阻断项仍待修复或验证')
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
