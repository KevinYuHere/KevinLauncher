import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// Windows ships the .NET Framework compiler with the OS. Building locally keeps
// the HUD helper fully reproducible and avoids any download/install step.
const root = resolve(import.meta.dirname, '..', '..')
export const kevinHudHelperSource = join(root, 'scripts', 'kevin-hud', 'KevinHud.cs')
export const kevinHudHelperDefaultOutput = join(root, 'out', 'native', 'KevinHud.exe')
export const kevinHudHelperSourceFiles = [
  import.meta.filename,
  kevinHudHelperSource
]

/**
 * Compile the read-only Kevin HUD helper atomically. Integration owns the
 * packaging hook that calls this and ships out/native/KevinHud.exe; the same
 * function is safe to run directly with `node scripts/kevin-hud/build.mjs`.
 */
export function buildKevinHudHelper(outputFile = kevinHudHelperDefaultOutput) {
  if (process.platform !== 'win32') throw new Error('Windows is required to build the Kevin HUD helper')
  if (!existsSync(kevinHudHelperSource)) throw new Error('Kevin HUD helper source is missing')
  const compiler = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  )
  if (!existsSync(compiler)) throw new Error('无法找到 Windows .NET Framework 编译器')

  const output = resolve(outputFile)
  const previous = statSync(output, { throwIfNoEntry: false })?.mtimeMs ?? 0
  const newestInput = Math.max(...kevinHudHelperSourceFiles.map(file => statSync(file).mtimeMs))
  if (previous >= newestInput) return output

  mkdirSync(dirname(output), { recursive: true })
  const temporary = mkdtempSync(join(dirname(output), '.kevin-hud-'))
  const staged = join(temporary, basename(output))
  try {
    execFileSync(compiler, [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/platform:x64',
      '/reference:System.dll',
      '/out:' + staged,
      kevinHudHelperSource
    ], { windowsHide: true, stdio: 'inherit' })
    renameSync(staged, output)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return output
}

if (import.meta.main) {
  console.log(buildKevinHudHelper())
}
