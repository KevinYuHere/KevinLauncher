import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import windowsExecutable from './windows-executable.js'

/** Build the same production installer layout for a stable release or a local Beta. */
export function buildWindowsInstaller(root) {
  if (process.platform !== 'win32') throw new Error('Windows 安装包须在 Windows 上构建')

  const { version, devDependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const electronDist = join('node_modules', 'electron', 'dist')
  const electronVersion = readFileSync(join(root, electronDist, 'version'), 'utf8').trim().replace(/^v/, '')
  if (electronVersion !== devDependencies.electron) throw new Error('Windows 安装包需要锁定的 Electron 运行库')
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  const options = { cwd: root, env, stdio: 'inherit', windowsHide: true }
  const node = (file, ...args) => execFileSync(process.execPath, [file, ...args], options)
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build'], options)
  const builder = join('node_modules', 'electron-builder', 'cli.js')
  node(builder, '--win', '--x64', '--dir', '--publish', 'never', '--config.electronDist=' + electronDist)
  const unpacked = join(root, 'release', 'win-unpacked')
  node(builder, '--win', '--x64', '--prepackaged', unpacked, '--publish', 'never')

  const installer = join(root, 'release', 'KevinLauncher-Installer-' + version + '.exe')
  const modes = {
    installerMode: 'requireAdministrator',
    entryMode: 'requireAdministrator',
    runtimeMode: 'asInvoker'
  }
  for (const [file, mode] of [
    [installer, modes.installerMode],
    [join(unpacked, 'KevinLauncher.exe'), modes.entryMode],
    [join(unpacked, 'KevinLauncherRuntime.exe'), modes.runtimeMode]
  ]) {
    windowsExecutable.assertExecutionLevel(file, mode)
    console.log('Verified ' + mode + ' in ' + file)
  }
  return { installer, unpacked, modes }
}

if (import.meta.main) buildWindowsInstaller(resolve(import.meta.dirname, '..'))
