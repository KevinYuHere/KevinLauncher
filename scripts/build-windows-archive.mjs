import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Windows ships the Framework compiler and archive library with the OS.
// Only our own small executable goes into the versioned application payload.
if (process.platform === 'win32') {
  const root = resolve(import.meta.dirname, '..')
  const output = process.env.KEVIN_NATIVE_OUTPUT ?? join(root, 'out', 'native')
  const exe = join(output, 'KevinArchive.exe')
  const source = join(root, 'scripts', 'hoyo-archive', 'WindowsArchive.cs')
  const manifest = join(root, 'scripts', 'hoyo-archive', 'long-path.manifest')
  const previous = statSync(exe, { throwIfNoEntry: false })?.mtimeMs ?? 0
  if ([source, manifest, import.meta.filename].some(file => statSync(file).mtimeMs > previous)) {
    mkdirSync(output, { recursive: true })
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64',
      '/out:' + exe, '/win32manifest:' + manifest, source], { windowsHide: true, stdio: 'inherit' })
  }
}
