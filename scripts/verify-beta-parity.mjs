import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import windowsExecutable from './windows-executable.js'

const require = createRequire(import.meta.url)
const { entry, runtime, trialEntry, trialRuntime } = require('../src/shared/windowsLayout.json')
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function verifyInstallerVersion(file, version) {
  const executable = NtExecutable.from(await readFile(file), { ignoreCert: true })
  const resources = NtExecutableResource.from(executable).entries
  const values = Resource.VersionInfo.fromEntries(resources).flatMap(info =>
    info.getAllLanguagesForStringValues().map(language => info.getStringValues(language)))
  assert.ok(values.length > 0, '安装程序需提供 Windows 产品版本')
  for (const metadata of values) {
    assert.equal(metadata.ProductName, 'KevinLauncher')
    assert.equal(metadata.ProductVersion, version)
  }
}

async function artifactIdentity(layout, version) {
  const resources = join(layout, 'resources')
  const payload = join(resources, `app-${version}`)
  assert.equal((await readFile(join(resources, 'app-version.txt'), 'utf8')).trim(), version)
  assert.deepEqual((await readdir(resources)).filter(name => /^app-\d/.test(name)), [`app-${version}`])
  const metadata = await readJson(join(payload, 'package.json'))
  assert.equal(metadata.name, 'kevin-launcher')
  assert.equal(metadata.version, version)
  const loader = require(join(resources, 'app', 'loader.js'))
  const selected = loader.selectApp(resources)
  assert.equal(selected.version, version)
  assert.equal(selected.main.toLowerCase(), join(payload, 'out', 'main', 'index.js').toLowerCase())
  assert.equal(selected.pending, false)
  const compatibility = await readJson(join(resources, 'release-compatibility.json'))
  assert.match(compatibility.hostSha256, /^[\da-f]{64}$/)
  assert.deepEqual(await readJson(join(payload, 'release-compatibility.json')), compatibility)
  assert.deepEqual(await readJson(join(resources, 'app-activation.json')), { schema: 1 })
  const bundledPolicy = await readJson(join(payload, 'theme-policy.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (bundledPolicy) assert.equal(bundledPolicy.version, version)

  const files = await readdir(layout)
  assert.ok(!files.includes(trialEntry) && !files.includes(trialRuntime), '发现旧试用版可执行文件')
  windowsExecutable.assertExecutionLevel(join(layout, entry), 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(layout, runtime), 'asInvoker')
  return { resources, payload, metadata, compatibility }
}

async function bundleFiles(payload) {
  const out = join(payload, 'out')
  const files = new Map()
  const requiredMain = new Set(['com.kevin.kevinlauncher', 'apps:launch', 'linked:launch', 'update:start',
    'appUpdate:check', 'releases/latest/download/update-manifest.json'])
  const blocked = ['com.kevin.kevinlauncher.trial', 'simulate-app-update.json', '"simulate.json"',
    '本地试用版已隔离', '检查本地模拟更新']
  for (const target of ['main', 'preload', 'renderer']) {
    const base = join(out, target)
    for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      assert.ok(entry.isFile(), entry.name)
      const file = join(entry.parentPath, entry.name)
      const name = file.slice(out.length + 1)
      const bytes = await readFile(file)
      if (name.endsWith('.js')) {
        for (const marker of blocked) {
          assert.ok(!bytes.includes(marker), `${name} 包含旧试用版模拟或功能限制：${marker}`)
        }
      }
      if (target === 'main') {
        for (const marker of requiredMain) {
          if (bytes.includes(marker)) requiredMain.delete(marker)
        }
      }
      files.set(name, createHash('sha256').update(bytes).digest('hex'))
    }
  }
  assert.deepEqual([...requiredMain], [], '应用缺少正式产品身份、启动或更新入口')
  const archive = join(out, 'native', 'KevinArchive.exe')
  assert.ok((await stat(archive)).isFile())
  for (const entry of [join('main', 'index.js'), join('preload', 'index.js'), join('renderer', 'index.html')]) {
    assert.ok(files.has(entry), `应用载荷缺少 ${entry}`)
  }
  return files
}

// The optional stable directory must come from the same source revision and toolchain.
const [batchArgument, stableArgument] = process.argv.slice(2)
assert.ok(batchArgument, '用法：node scripts/verify-beta-parity.mjs <release-beta-* 目录> [同源码的正式版 win-unpacked 目录]')
const batch = resolve(batchArgument)
const beta = await readJson(join(batch, 'beta-verification.json'))
assert.match(beta.version, /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/)
assert.equal(beta.installer, `KevinLauncher-Installer-${beta.version}.exe`)
assert.equal(beta.installerMode, 'requireAdministrator')
assert.equal(beta.entryMode, 'requireAdministrator')
assert.equal(beta.runtimeMode, 'asInvoker')
const installer = join(batch, beta.installer)
assert.equal((await stat(installer)).size, beta.size)
assert.equal(await sha256(installer), beta.sha256)
windowsExecutable.assertExecutionLevel(installer, 'requireAdministrator')
await verifyInstallerVersion(installer, beta.version)
const installedBeta = await artifactIdentity(join(batch, 'win-unpacked'), beta.version)
const betaFiles = await bundleFiles(installedBeta.payload)

if (stableArgument) {
  const layout = resolve(stableArgument)
  const version = (await readFile(join(layout, 'resources', 'app-version.txt'), 'utf8')).trim()
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const stable = await artifactIdentity(layout, version)
  assert.deepEqual({ ...installedBeta.metadata, version }, stable.metadata)
  assert.deepEqual(installedBeta.compatibility, stable.compatibility)
  assert.deepEqual(betaFiles, await bundleFiles(stable.payload), '主进程、预加载与渲染文件的 SHA-256 应一致')
}

console.log(`通过 ${beta.version} 的安装包哈希、Windows 入口、实际应用载荷及生产构建检查${stableArgument ? '，同源码正式版的应用文件逐项匹配' : ''}`)
