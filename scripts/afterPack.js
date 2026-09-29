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

  fs.writeFileSync(path.join(resources, 'app-version.txt'), version, 'utf8')
  console.log(`afterPack: app-version.txt -> ${version}`)
}
