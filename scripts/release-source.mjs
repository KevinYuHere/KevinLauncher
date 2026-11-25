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

function codexMarker(body, marker) {
  const serialized = (body ?? '').match(new RegExp('<!--\\s*' + marker + '\\s+([\\s\\S]*?)\\s*-->'))?.[1]
  if (serialized === undefined) return undefined
  try { return JSON.parse(serialized) ?? {} } catch { return {} }
}

function securityReviewFindings(threads) {
  return threads.flatMap(thread => {
    const comment = thread?.comments?.nodes?.[0]
    const original = comment?.originalCommit?.oid
    if (comment?.author?.__typename !== 'Bot' ||
        !['chatgpt-codex-connector', codexLogin].includes(comment.author.login) ||
        !/^<!-- codex-security-review-finding:v1 -->\r?$/m.test(comment.body ?? '') ||
        !shaPattern.test(original ?? '') || !Number.isSafeInteger(comment.databaseId)) return []
    return [{ id: String(comment.databaseId), original, resolved: thread.isResolved === true }]
  })
}

function archivedSecurityFindings(body, sha, scope, findings) {
  const [, section, extra] = body.split(/^### Security findings[ \t]*\r?$/mi)
  if (section === undefined) return true
  if (extra !== undefined) return false
  const rows = section.split(/^<details\b|^### /m)[0].split(/\r?\n/).filter(line => /^\s*[-*] /.test(line))
  const prefix = 'https://github.com/' + scope.repository + '/pull/' + scope.pullRequestNumber + '#discussion_r'
  const resolved = new Set(findings.filter(finding => finding.resolved && finding.original !== sha).map(finding => finding.id))
  return rows.length > 0 && rows.every(row => {
    const links = [...row.matchAll(/\]\((https:\/\/[^)]+)\)/g)]
    return links.length === 1 && links[0][1].startsWith(prefix) && resolved.has(links[0][1].slice(prefix.length))
  })
}

function completedSecurityReview(state, body, sha, issueUrl, threads) {
  const scope = codexMarker(body, 'codex-security-review:v1')
  if (state?.commit_sha !== sha || state.status !== 'completed' || scope?.headSha !== sha ||
      scope.status !== 'completed' || !Number.isSafeInteger(scope.pullRequestNumber) ||
      'https://api.github.com/repos/' + scope.repository + '/issues/' + scope.pullRequestNumber !== issueUrl) return false
  const findings = securityReviewFindings(threads)
  if (findings.some(finding => finding.original === sha && !finding.resolved)) return false
  if (state.has_unresolved_findings === false) return typeof state.has_any_findings === 'boolean'
  // A clean security pass can still display advisories carried forward from older commits.
  return state.has_any_findings === null && state.has_unresolved_findings === null &&
    archivedSecurityFindings(body, sha, scope, findings)
}

export function completedCodexReview(reviews, comments, sha, mergedAt, issueUrl, threads = []) {
  const beforeMerge = time => Date.parse(time) <= Date.parse(mergedAt)
  const trusted = item => item.user?.login === codexLogin &&
    item.user.type === 'Bot' &&
    (!item.performed_via_github_app || item.performed_via_github_app.slug === 'chatgpt-codex-connector')
  const trustedComments = comments.filter(comment => trusted(comment) && comment.issue_url === issueUrl)
  const summaries = trustedComments.flatMap(comment => {
    const state = codexMarker(comment.body, 'codex-review-state:v1')
    return state === undefined ? [] : [{ comment, state }]
  }).sort((a, b) => Date.parse(b.comment.updated_at) - Date.parse(a.comment.updated_at) || b.comment.id - a.comment.id)
  const latest = summaries[0]
  if (!latest) return undefined
  const { comment, state: { code_review: state, security_review: security } } = latest
  if (state?.commit_sha !== sha || !shaPattern.test(state.commit_sha) || state.status !== 'completed' ||
      typeof state.has_any_findings !== 'boolean' || state.has_unresolved_findings !== false ||
      !beforeMerge(comment.created_at) || !beforeMerge(comment.updated_at) ||
      !completedSecurityReview(security, comment.body, sha, issueUrl, threads)) return undefined
  if (reviews.some(review => trusted(review) && review.commit_id === sha &&
      ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state) &&
      Date.parse(review.submitted_at) > Date.parse(comment.updated_at))) return undefined
  return { id: comment.id, url: comment.html_url, submittedAt: comment.updated_at, reviewed: state.commit_sha }
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

export async function pullRequestReviewThreads(number, sha) {
  const [owner, repo] = repository().split('/')
  const query = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 1) {
              nodes { databaseId author { __typename login } body originalCommit { oid } }
            }
          }
        }
      }
    }
  }`
  const threads = []
  let cursor = null
  for (let page = 0; page < 20; page++) {
    const response = await githubRequest('https://api.github.com/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, repo, number, cursor } })
    })
    const pr = response.data?.repository?.pullRequest
    const connection = pr?.reviewThreads
    if (response.errors?.length || pr?.headRefOid !== sha || !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('无法确认准确 PR 提交的审阅讨论')
    threads.push(...connection.nodes)
    if (!connection.pageInfo.hasNextPage) return threads
    const next = connection.pageInfo.endCursor
    if (typeof next !== 'string' || !next || cursor === next) throw new Error('GitHub 审阅讨论分页无效')
    cursor = next
  }
  throw new Error('GitHub 审阅讨论超出校验限制')
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
    const [reviews, comments, priorCiRuns, threads] = await Promise.all([
      pages('/pulls/' + pr.number + '/reviews'),
      pages('/issues/' + pr.number + '/comments'),
      pages('/actions/workflows/ci.yml/runs?event=pull_request&head_sha=' + head, 'workflow_runs'),
      pullRequestReviewThreads(pr.number, head)
    ])
    const issueUrl = 'https://api.github.com/repos/' + repo + '/issues/' + pr.number
    const review = completedCodexReview(reviews, comments, head, pr.merged_at, issueUrl, threads)
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
