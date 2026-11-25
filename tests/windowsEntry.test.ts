import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildWindowsEntry, windowsEntrySourceFiles } from '../scripts/build-windows-entry.mjs'

const require = createRequire(import.meta.url)
const { assertExecutionLevel } = require('../scripts/windows-executable.js')

describe.skipIf(process.platform !== 'win32')('Windows launcher entry', () => {
  let root: string
  let entry: string
  let runtime: string
  let cwd: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kl-entry-')))
    const layout = join(root, '程序 目录')
    cwd = join(root, '当前 目录')
    mkdirSync(layout)
    mkdirSync(cwd)
    entry = join(layout, 'KevinLauncher.exe')
    runtime = join(layout, 'KevinLauncherRuntime.exe')
    const elevated = join(root, 'KevinLauncher.exe')
    buildWindowsEntry(elevated)
    const pe = readFileSync(elevated)
    const header = pe.readUInt32LE(0x3c)
    expect(pe.readUInt16LE(header + 4)).toBe(0x8664)
    expect(pe.readUInt16LE(header + 24)).toBe(0x20b)
    expect(pe.readUInt16LE(header + 24 + 68)).toBe(2)
    assertExecutionLevel(elevated, 'requireAdministrator')

    const [, source, manifest] = windowsEntrySourceFiles
    const invoker = join(root, 'test-invoker.manifest')
    writeFileSync(invoker, readFileSync(manifest, 'utf8').replace('requireAdministrator', 'asInvoker'))
    const compiler = join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    const compile = (file: string, code: string) => execFileSync(compiler,
      ['/nologo', '/optimize+', '/target:winexe', '/platform:x64', '/out:' + file, '/win32manifest:' + invoker, code],
      { windowsHide: true })
    // Only this test copy is runnable without prompting the logged-in user for UAC.
    compile(entry, source)
    assertExecutionLevel(entry, 'asInvoker')
    compile(runtime, join(import.meta.dirname, 'fixtures', 'windows-entry-runtime.cs'))
  })

  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

  test('inherits the current directory, arguments, portable identity, streams and full child exit code', () => {
    const portable = join(root, '包 文件.exe')
    const args = ['--install', '', '中文 with spaces', 'literal"quote', 'backslash\\"quote', 'trailing slash\\']
    const child = spawnSync(entry, args, {
      cwd, env: { ...process.env, PORTABLE_EXECUTABLE_FILE: portable, ELECTRON_RUN_AS_NODE: '1' }, input: 'fixture stdin\n',
      encoding: 'utf8', windowsHide: true, timeout: 10000
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status! >>> 0).toBe(0x80000003)
    expect(child.stdout.trimEnd().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString('utf8')))
      .toEqual([...args, cwd, portable, '', 'fixture stdin'])
    expect(child.stderr.trim()).toBe('fixture stderr')
  })

  test('reports the original Windows error when the fixed sibling is missing', () => {
    const incomplete = join(root, '缺少 运行库')
    mkdirSync(incomplete)
    const testedEntry = join(incomplete, 'KevinLauncher.exe')
    writeFileSync(testedEntry, readFileSync(entry))
    const child = spawnSync(testedEntry, [], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(2)
    expect(child.stderr).toContain('KevinLauncherRuntime.exe (2)')
  })
})
