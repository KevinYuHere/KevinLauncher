import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { artifactName, assertTag, github, pages } from './release-source.mjs'
import { assetNames, mayBuildBatch, missingDraftAssets, verifyLocalAssets } from './release-assets.mjs'

const command = process.argv[2]
const sourceFile = process.argv[3]
const source = JSON.parse(await readFile(sourceFile, 'utf8'))
const workflowPath = '.github/workflows/release.yml'

async function originalRun(runId) {
  if (!/^[1-9]\d*$/.test(runId ?? '')) throw new Error('缺少正式标签的原始运行 ID')
  const data = await github('/actions/runs/' + runId)
  if (data.event !== 'push' || data.path !== workflowPath || data.head_sha !== source.sha ||
      data.head_branch !== source.tag || data.repository?.full_name !== process.env.GITHUB_REPOSITORY) {
    throw new Error('指定运行并非同一标签和提交的正式 push')
  }
  return data
}

async function artifactFor(runId) {
  const artifacts = await pages('/actions/runs/' + runId + '/artifacts', 'artifacts')
  const matching = artifacts.filter(artifact => artifact.name === artifactName(source.sha))
  if (matching.length > 1) throw new Error('正式 push 存在多个候选批次')
  return matching[0]
}

if (command === 'new') {
  const runId = process.env.GITHUB_RUN_ID
  await originalRun(runId)
  const other = await pages('/actions/workflows/release.yml/runs?event=push&branch=' +
    encodeURIComponent(source.tag), 'workflow_runs')
  if (other.some(run => String(run.id) !== runId)) {
    throw new Error('此正式标签已启动过发布，不能创建第二批候选产物')
  }
  const artifact = await artifactFor(runId)
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Actions 运行次数无效')
  let frozen = false
  if (!artifact) {
    for (let prior = 1; prior < attempt; prior++) {
      const jobs = await pages('/actions/runs/' + runId + '/attempts/' + prior + '/jobs', 'jobs')
      frozen ||= jobs.some(job => job.steps?.some(step =>
        step.name === 'Freeze the verified official batch' && step.conclusion === 'success'))
    }
  }
  await appendFile(process.env.GITHUB_OUTPUT, 'reused=' + !mayBuildBatch(artifact, frozen) + '\n')
} else if (command === 'select') {
  const runId = process.env.GITHUB_EVENT_NAME === 'push'
    ? process.env.GITHUB_RUN_ID : process.env.RETRY_SOURCE_RUN
  await originalRun(runId)
  const artifact = await artifactFor(runId)
  if (!artifact || artifact.expired || !/^sha256:[0-9a-f]{64}$/i.test(artifact.digest ?? '')) {
    throw new Error('原始标签 push 的冻结批次不可用，禁止重新打包覆盖')
  }
  for (const [key, value] of Object.entries({ runId, artifactId: artifact.id, artifactDigest: artifact.digest })) {
    await appendFile(process.env.GITHUB_OUTPUT, key + '=' + value + '\n')
  }
} else if (command === 'publish') {
  const dir = resolve(process.argv[4])
  const runId = process.env.RELEASE_RUN_ID
  const artifactDigest = process.env.RELEASE_ARTIFACT_DIGEST
  const artifact = await artifactFor(runId)
  if (!artifact || artifact.expired || String(artifact.id) !== process.env.RELEASE_ARTIFACT_ID ||
      artifact.digest !== artifactDigest) throw new Error('冻结产物身份改变')
  await originalRun(runId)
  const recordedSource = JSON.parse(await readFile(join(dir, 'release-source.json'), 'utf8'))
  if (['version', 'electron', 'tag', 'sha', 'tree', 'head', 'base', 'pr'].some(
    key => recordedSource[key] !== source[key])) throw new Error('候选批次的源码证据不符')
  const verification = JSON.parse(await readFile(join(dir, 'windows-verification.json'), 'utf8'))
  const assets = await verifyLocalAssets(dir, source.version, source.electron)
  if (verification.runId !== runId || verification.sha !== source.sha || verification.tree !== source.tree ||
      verification.version !== source.version || verification.electron !== source.electron ||
      verification.entryMode !== 'requireAdministrator' || verification.runtimeMode !== 'asInvoker' ||
      !['freshInstall', 'launched', 'overwriteUpgrade', 'historyPreserved', 'payloadMatchesInstalled', 'uninstalled']
        .every(key => verification[key] === true) ||
      !assetNames(source.version).every(name => verification.assets?.[name]?.size === assets[name].size &&
        verification.assets[name].sha256 === assets[name].sha256)) {
    throw new Error('冻结产物缺少同一文件的 Windows 安装、启动和覆盖升级证据')
  }
  const hash = createHash('sha256').update(JSON.stringify(assets)).digest('hex')
  const marker = '<!-- KevinLauncher: source=' + source.sha + ' run=' + runId + ' files=' + hash + ' -->'
  const title = 'KevinLauncher ' + source.version
  const manifest = JSON.parse(await readFile(join(dir, 'update-manifest.json'), 'utf8'))
  const notes = (await readFile(join(dir, 'RELEASE_NOTES.md'), 'utf8')).trim()
  if (!notes || notes !== manifest.notes) throw new Error('发布说明与更新清单不一致')
  const notesFile = join(dir, 'publish-notes.md')
  const verificationLink = 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + runId
  await writeFile(notesFile, notes + '\n\n' + marker + '\n<!-- Verification: ' + verificationLink + ' -->\n')
  const gh = (...args) => execFileSync('gh', [...args, '--repo', process.env.GITHUB_REPOSITORY], {
    stdio: 'inherit', windowsHide: true
  })
  const loadRelease = async () => {
    const all = await pages('/releases')
    const matching = all.filter(release => release.tag_name === source.tag)
    if (matching.length > 1) throw new Error('同名正式标签有多个发布记录')
    return matching[0]
  }
  await assertTag(source.tag, source.sha)
  let release = await loadRelease()
  if (!release) {
    gh('release', 'create', source.tag, '--verify-tag', '--draft', '--title', title, '--notes-file', notesFile)
    release = await loadRelease()
  }
  const missing = missingDraftAssets(release, assets, marker)
  if (!release.draft) {
    console.log('正式发布已完成，同一批资产保持原样')
  } else {
    for (const file of missing) gh('release', 'upload', source.tag, join(dir, file))
    const checked = await loadRelease()
    if (!checked?.draft || missingDraftAssets(checked, assets, marker).length) throw new Error('草稿资产校验失败')
    await assertTag(source.tag, source.sha)
    gh('release', 'edit', source.tag, '--draft=false')
  }
} else {
  throw new Error('预期子命令 new、select 或 publish')
}
