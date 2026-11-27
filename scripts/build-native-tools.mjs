import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildKevinHudHelper, kevinHudHelperDefaultOutput } from './kevin-hud/build.mjs'

const root = resolve(import.meta.dirname, '..')
const archiveBuilder = join(root, 'scripts', 'build-windows-archive.mjs')

/** Native tools shipped below the versioned `out/` payload. */
export const nativeToolPaths = {
  archive: join(root, 'out', 'native', 'KevinArchive.exe'),
  hud: kevinHudHelperDefaultOutput
}

function requireBuiltTool(name, file) {
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`build-native-tools: 缺少${name} ${file}`)
  }
}

/**
 * Build the Windows native tools used by the versioned application payload.
 *
 * The existing archive builder remains the single implementation of that
 * compile step; this hook runs it unchanged, then builds the read-only HUD
 * helper. Both outputs live under `out/native/`, which electron-builder copies
 * into `resources/app-<version>/out` for the installer and hot-update payload.
 *
 * Windows-only. On other platforms the hooks stay usable and no Windows-only
 * compiler is invoked.
 *
 * @returns {{ archive: string, hud: string } | null}
 */
export function buildNativeTools() {
  if (process.platform !== 'win32') {
    console.log('build-native-tools: 非 Windows 平台，跳过 Windows 原生工具构建')
    return null
  }

  execFileSync(process.execPath, [archiveBuilder], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  })
  const hud = buildKevinHudHelper()
  requireBuiltTool('Windows 解压工具', nativeToolPaths.archive)
  requireBuiltTool('Windows HUD 辅助程序', hud)
  console.log('build-native-tools: KevinArchive.exe / KevinHud.exe 已就绪')
  return { archive: nativeToolPaths.archive, hud }
}

if (import.meta.main) buildNativeTools()
