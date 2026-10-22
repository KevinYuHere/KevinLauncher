const fs = require('node:fs')
const path = require('node:path')

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

  // Release theme policy: the file only travels with **its own** version, so a
  // later build can never inherit (or re-apply) an older release's settings.
  const policySource = path.join(projectDir, 'theme-policy.json')
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
      console.log(
        `afterPack: theme-policy.json 属于 ${policy?.version ?? '未知版本'}，与本次 ${version} 不符 - 未内嵌`
      )
    }
  }

  fs.writeFileSync(path.join(resources, 'app-version.txt'), version, 'utf8')
  console.log(`afterPack: app-version.txt -> ${version}`)
}
