const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { assertExecutionLevel, prepareWindowsExecutable } = require('./windows-executable.js')
const windowsLayout = require('../src/shared/windowsLayout.json')

/**
 * electron-builder afterPack hook.
 *
 * 1. Ensures `resources/app/package.json` exists (electron-builder skips
 *    `package.json` when copying a `files` FileSet, but Electron needs it to
 *    recognise `resources/app/` as the application entry).
 * 2. Writes `resources/app-version.txt` — the pointer read by shell/loader.js.
 * 3. Validates that the versioned application directory shipped correctly
 *    (`resources/app-<version>/`, provided through `extraResources`), including
 *    the archive/HUD native helpers and the standalone HUD document/preload.
 * 4. Embeds the release policy for the exact packaged version, preferring
 *    `resources/release-policies/<version>.json` over the legacy root
 *    `theme-policy.json`, as `resources/app-<version>/theme-policy.json`.
 */
module.exports = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir
  const resources = path.join(context.appOutDir, 'resources')
  const version = context.packager.appInfo.version

  const appDir = path.join(resources, 'app')
  fs.mkdirSync(appDir, { recursive: true })
  const appPackageJson = path.join(appDir, 'package.json')
  if (!fs.existsSync(appPackageJson)) {
    fs.copyFileSync(path.join(projectDir, 'shell', 'package.json'), appPackageJson)
    console.log('afterPack: 写入 resources/app/package.json')
  }

  const entry = path.join(appDir, 'out', 'main', 'index.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`afterPack: 缺少入口 ${entry}（检查 files 配置）`)
  }

  const versionedEntry = path.join(resources, `app-${version}`, 'out', 'main', 'index.js')
  if (!fs.existsSync(versionedEntry)) {
    throw new Error(`afterPack: 缺少应用目录 app-${version}（检查 extraResources 配置）`)
  }
  const mainDirectory = path.dirname(versionedEntry)
  const mainCode = fs.readdirSync(mainDirectory, { recursive: true })
    .filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(mainDirectory, file), 'utf8'))
    .join('\n')
  const simulation = ['simulate-app-update.json', "'simulate.json'", '"simulate.json"', 'update:simulate']
  if (simulation.some(marker => mainCode.includes(marker))) {
    throw new Error('应用构建身份与安装程序配置不一致')
  }
  const versionedOut = path.join(resources, `app-${version}`, 'out')
  const requiredPayload = [
    ['Windows 解压工具', path.join(versionedOut, 'native', 'KevinArchive.exe')],
    ['Windows HUD 辅助程序', path.join(versionedOut, 'native', 'KevinHud.exe')],
    ['HUD 页面', path.join(versionedOut, 'renderer', 'hud.html')],
    ['HUD 预加载脚本', path.join(versionedOut, 'preload', 'kevinHud.js')]
  ]
  for (const [label, file] of requiredPayload) {
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`afterPack: 缺少${label} ${file}（检查构建输出与 extraResources 配置）`)
    }
  }
  console.log('afterPack: 已验证原生工具与 HUD 页面/预加载')
  const nativeSources = []
  if (context.electronPlatformName === 'win32') {
    const name = `${context.packager.appInfo.productFilename}.exe`
    const entryName = windowsLayout.entry
    const runtimeName = windowsLayout.runtime
    if (name !== entryName) throw new Error('Windows 入口文件名与构建身份不一致')
    const entry = path.join(context.appOutDir, name)
    const runtime = path.join(context.appOutDir, runtimeName)
    const icon = path.join(projectDir, 'resources', 'icon.ico')
    const { buildWindowsEntry, windowsEntrySourceFiles } = await import('./build-windows-entry.mjs')
    fs.renameSync(entry, runtime)
    prepareWindowsExecutable(runtime, icon, 'asInvoker')
    buildWindowsEntry(entry)
    assertExecutionLevel(entry, 'requireAdministrator')
    assertExecutionLevel(runtime, 'asInvoker')
    nativeSources.push(...windowsEntrySourceFiles,
      path.join(projectDir, 'src/shared/windowsLayout.json'), path.join(__dirname, 'windows-executable.js'))
  }
  const { kevinHudHelperSourceFiles } = await import('./kevin-hud/build.mjs')
  const fingerprint = createHash('sha256')
  const hostFiles = [
    ...['app/package.json', 'app/loader.js', 'app/out/main/index.js', 'hpatchz.exe', 'icon.ico', 'icon.png']
      .map(file => path.join(resources, file)),
    ...['scripts/hoyo-archive/WindowsArchive.cs', 'scripts/hoyo-archive/long-path.manifest',
      'scripts/build-windows-archive.mjs', 'scripts/build-native-tools.mjs']
      .map(file => path.join(projectDir, file)),
    ...kevinHudHelperSourceFiles,
    ...nativeSources
  ]
  for (const file of hostFiles) {
    const content = fs.readFileSync(file)
    fingerprint.update(String(content.length) + ':').update(content)
  }
  const protocols = JSON.parse(fs.readFileSync(path.join(projectDir, 'scripts/release-compatibility.json'), 'utf8'))
  const compatibility = JSON.stringify({ ...protocols, hostSha256: fingerprint.digest('hex') })
  fs.writeFileSync(path.join(resources, 'release-compatibility.json'), compatibility, 'utf8')
  fs.writeFileSync(path.join(resources, `app-${version}`, 'release-compatibility.json'), compatibility, 'utf8')
  fs.writeFileSync(path.join(resources, 'app-activation.json'), '{"schema":1}', 'utf8')

  // Release policy: the preferred file is `resources/release-policies/<version>.json`.
  // It is keyed by the exact complete version, so a later build can never inherit
  // (or re-apply) another release's settings. The legacy root `theme-policy.json`
  // remains supported when no exact-version policy exists.
  const versionedPolicySource = path.join(
    projectDir, 'resources', 'release-policies', `${version}.json`
  )
  const legacyPolicySource = path.join(projectDir, 'theme-policy.json')
  const policySource = fs.existsSync(versionedPolicySource)
    ? versionedPolicySource
    : fs.existsSync(legacyPolicySource)
      ? legacyPolicySource
      : null
  if (policySource) {
    const policyLabel = policySource === versionedPolicySource
      ? `resources/release-policies/${version}.json`
      : 'theme-policy.json'
    let policy
    try {
      policy = JSON.parse(fs.readFileSync(policySource, 'utf8'))
    } catch (error) {
      throw new Error(`afterPack: ${policyLabel} 无法解析（${error.message}）`)
    }
    if (policy && policy.version === version) {
      fs.copyFileSync(policySource, path.join(resources, `app-${version}`, 'theme-policy.json'))
      console.log(`afterPack: 内嵌 ${policyLabel}`)
    } else if (policySource === versionedPolicySource) {
      throw new Error(
        `afterPack: ${policyLabel} 属于 ${policy?.version ?? '未知版本'}，与本次 ${version} 不符 - 已拒绝打包`
      )
    } else {
      console.log(
        `afterPack: theme-policy.json 属于 ${policy?.version ?? '未知版本'}，与本次 ${version} 不符 - 未内嵌`
      )
    }
  }

  fs.writeFileSync(path.join(resources, 'app-version.txt'), version, 'utf8')
  console.log(`afterPack: app-version.txt -> ${version}`)
}
