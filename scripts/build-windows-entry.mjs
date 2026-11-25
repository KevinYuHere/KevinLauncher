import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'scripts', 'windows-entry', 'WindowsEntry.cs')
const manifest = join(root, 'scripts', 'windows-entry', 'elevated.manifest')
const icon = join(root, 'resources', 'icon.ico')
export const windowsEntrySourceFiles = [import.meta.filename, source, manifest]

export function buildWindowsEntry(outputFile) {
  if (process.platform !== 'win32') throw new Error('Windows is required to build the launcher entry')
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const output = resolve(outputFile)
  const temp = mkdtempSync(join(dirname(output), '.windows-entry-'))
  const staged = join(temp, basename(output))
  try {
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:winexe', '/platform:x64', '/out:' + staged,
      '/win32manifest:' + manifest, '/win32icon:' + icon, source], { windowsHide: true, stdio: 'inherit' })
    renameSync(staged, output)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
