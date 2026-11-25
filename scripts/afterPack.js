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
 *    (`resources/app-<version>/`, provided through `extraResources`).
 */
module.exports = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir
  const resources = path.join(context.appOutDir, 'resources')
  const version = context.packager.appInfo.version
  const trial = context.packager.config.appId === 'com.kevin.kevinlauncher.trial'

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
  const includesSimulation = mainCode.includes(simulation[0])
  if (trial ? !includesSimulation : simulation.some(marker => mainCode.includes(marker))) {
    throw new Error('应用构建身份与安装程序配置不一致')
  }
  const archiveTool = path.join(resources, `app-${version}`, 'out', 'native', 'KevinArchive.exe')
  if (!fs.existsSync(archiveTool)) throw new Error(`缺少本项目的 Windows 解压工具 ${archiveTool}`)
  const nativeSources = []
  if (context.electronPlatformName === 'win32') {
    const name = `${context.packager.appInfo.productFilename}.exe`
    const entryName = trial ? windowsLayout.trialEntry : windowsLayout.entry
    const runtimeName = trial ? windowsLayout.trialRuntime : windowsLayout.runtime
    if (name !== entryName) throw new Error('Windows 入口文件名与构建身份不一致')
    const entry = path.join(context.appOutDir, name)
    const runtime = path.join(context.appOutDir, runtimeName)
    const icon = path.join(projectDir, 'resources', 'icon.ico')
    const { buildWindowsEntry, windowsEntrySourceFiles } = await import('./build-windows-entry.mjs')
    fs.renameSync(entry, runtime)
    prepareWindowsExecutable(runtime, icon, 'asInvoker')
    buildWindowsEntry(entry, trial)
    assertExecutionLevel(entry, 'requireAdministrator')
    assertExecutionLevel(runtime, 'asInvoker')
    nativeSources.push(...windowsEntrySourceFiles,
      path.join(projectDir, 'src/shared/windowsLayout.json'), path.join(__dirname, 'windows-executable.js'))
  }
  const fingerprint = createHash('sha256')
  const hostFiles = [
    ...['app/package.json', 'app/loader.js', 'app/out/main/index.js', 'hpatchz.exe', 'icon.ico', 'icon.png']
      .map(file => path.join(resources, file)),
    ...['scripts/hoyo-archive/WindowsArchive.cs', 'scripts/hoyo-archive/long-path.manifest', 'scripts/build-windows-archive.mjs']
      .map(file => path.join(projectDir, file)),
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

  // Release theme policy: the file only travels with **its own** version, so a
  // later build can never inherit (or re-apply) an older release's settings.
  const trialPolicy = trial && process.env.KEVIN_TRIAL_THEME_POLICY
  const policySource = trialPolicy || path.join(projectDir, 'theme-policy.json')
  if (trialPolicy && !fs.existsSync(policySource)) throw new Error('找不到试用主题策略')
  if (fs.existsSync(policySource)) {
    let policy
    try {
      policy = JSON.parse(fs.readFileSync(policySource, 'utf8'))
    } catch (error) {
      throw new Error(`afterPack: theme-policy.json 无法解析（${error.message}）`)
    }
    if (policy && policy.version === version) {
      fs.copyFileSync(policySource, path.join(resources, `app-${version}`, 'theme-policy.json'))
      console.log('afterPack: 内嵌 theme-policy.json')
    } else {
      if (trialPolicy) throw new Error('试用主题策略必须和当前试用安装包版本相同')
      console.log(
        `afterPack: theme-policy.json 属于 ${policy?.version ?? '未知版本'}，与本次 ${version} 不符 - 未内嵌`
      )
    }
  }

  fs.writeFileSync(path.join(resources, 'app-version.txt'), version, 'utf8')
  console.log(`afterPack: app-version.txt -> ${version}`)
}
