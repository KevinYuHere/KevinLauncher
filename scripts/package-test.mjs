import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

if (process.platform !== 'win32') throw new Error('本地试用安装包须在 Windows 上构建')
const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: { 'theme-policy': { type: 'string' }, 'keep-unpacked': { type: 'boolean' } }
})
const { name: packageName, version, devDependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const electronDist = join(root, 'node_modules', 'electron', 'dist')
const runtime = (await readFile(join(electronDist, 'version'), 'utf8').catch(() => '')).trim().replace(/^v/, '')
if (runtime !== devDependencies.electron) throw new Error('请先运行 scripts/install.ps1 安装锁定的 Electron 运行库')
const output = await mkdtemp(join(root, 'release-trial-'))
const temp = join(output, 'tmp')
const exe = 'KevinLauncherTrial.exe'
const installer = `KevinLauncherTrial-Installer-${version}.exe`
const env = {
  ...process.env,
  KEVIN_BUILD_IDENTITY: 'trial',
  KEVIN_TRIAL_THEME_POLICY: values['theme-policy'] ? resolve(values['theme-policy']) : '',
  KEVIN_NATIVE_OUTPUT: join(output, 'app', 'native'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  TEMP: temp,
  TMP: temp
}

function node(script, ...args) {
  execFileSync(process.execPath, [join(root, script), ...args], { cwd: root, env, stdio: 'inherit' })
}

// electron-builder deep-merges .js config with the registered production layout.
const config = join(output, 'builder.cjs')
const bundled = relative(root, join(output, 'app')).split(sep).join('/')
const configuration = [
  'const fs = require("node:fs")',
  'const yaml = require("js-yaml")',
  'const base = yaml.load(fs.readFileSync("electron-builder.yml", "utf8"))',
  'module.exports = {',
  '  ...base,',
  '  appId: "com.kevin.kevinlauncher.trial", productName: "KevinLauncherTrial",',
  '  electronDist: ' + JSON.stringify(electronDist) + ',',
  `  directories: { output: ${JSON.stringify(output)} },`,
  `  extraResources: base.extraResources.map(rule => rule.from === "out" ? { ...rule, from: ${JSON.stringify(bundled)} } : rule),`,
  '  portable: { ...base.portable, requestExecutionLevel: "user" }',
  '}'
].join('\n')

const builder = 'node_modules/electron-builder/cli.js'
const unpacked = join(output, 'win-unpacked')
const file = join(output, installer)
try {
  await mkdir(temp)
  for (const command of ['npm.cmd run typecheck', 'npm.cmd test']) {
    execFileSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: root, stdio: 'inherit' })
  }
  node('node_modules/electron-vite/bin/electron-vite.js', 'build', '--outDir', join(output, 'app'))
  node('scripts/build-windows-archive.mjs')
  await writeFile(config, configuration)
  node(builder, '--config', config, '--win', '--x64', '--dir', '--publish', 'never')
  node(builder, '--config', config, '--win', '--x64', '--prepackaged', unpacked, '--publish', 'never')
  node('scripts/windows-executable.js', '--trial', join(unpacked, exe), file)
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(file)) sha256.update(chunk)
  await writeFile(join(output, 'trial-verification.json'), JSON.stringify({
    identity: 'trial', version, installer, size: (await stat(file)).size, sha256: sha256.digest('hex')
  }, null, 2) + '\n')
} catch (error) {
  await rm(file, { force: true })
  throw error
} finally {
  const check = relative(root, output)
  if (check.startsWith('release-trial-') && !check.includes(sep)) {
    for (const name of ['app', 'tmp', 'builder.cjs', 'builder-effective-config.yaml', 'builder-debug.yml',
      `${packageName}-${version}-x64.nsis.7z`,
      ...(values['keep-unpacked'] ? [] : ['win-unpacked'])]) {
      await rm(join(output, name), { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
console.log(file)
