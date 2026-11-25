import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildWindowsEntry, windowsEntrySourceFiles } from '../scripts/build-windows-entry.mjs'

const require = createRequire(import.meta.url)
const { assertExecutionLevel } = require('../scripts/windows-executable.js')

describe.skipIf(process.platform !== 'win32')('Windows launcher entry', () => {
  let root: string
  let entry: string
  let runtime: string
  let cwd: string
  let legacy: string
  let installedBrowser: string

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
    const legacyDir = join(root, '旧 版本')
    mkdirSync(legacyDir)
    legacy = join(legacyDir, 'KevinLauncher.exe')
    installedBrowser = join(legacyDir, 'KevinLauncherRuntime.exe')
    compile(legacy, join(import.meta.dirname, 'fixtures', 'windows-entry-close.cs'))
    compile(installedBrowser, join(import.meta.dirname, 'fixtures', 'windows-entry-close.cs'))
  })

  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

  test('inherits the current directory, arguments, portable identity, streams and full child exit code', () => {
    const portable = join(root, '包 文件.exe')
    const args = ['--install', '', '中文 with spaces', 'literal"quote', 'backslash\\"quote', 'trailing slash\\']
    const child = spawnSync(entry, args, {
      cwd, env: {
        ...process.env, PORTABLE_EXECUTABLE_FILE: portable, ELECTRON_RUN_AS_NODE: '1', SystemRoot: cwd, windir: cwd
      }, input: 'fixture stdin\n',
      encoding: 'utf8', windowsHide: true, timeout: 10000
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status! >>> 0).toBe(0x80000003)
    const output = child.stdout.trimEnd().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString('utf8'))
    expect(output.slice(0, args.length)).toEqual(args)
    // The runner's 8.3 TEMP alias can differ from the directory reported by .NET.
    expect(realpathSync.native(output[args.length])).toBe(realpathSync.native(cwd))
    expect(output.slice(args.length + 1, args.length + 4)).toEqual([portable, '', 'fixture stdin'])
    const windows = realpathSync.native(process.env.SystemRoot!)
    expect(output.slice(args.length + 4).map(path => realpathSync.native(path))).toEqual([windows, windows])
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

  test.each(['legacy window', 'installed browser'] as const)('only posts a close to hidden Chrome windows of the verified %s', async kind => {
    const image = kind === 'legacy window' ? legacy : installedBrowser
    const message = kind === 'legacy window' ? 'close:' : 'setup:'
    const target = spawn(image, [], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    target.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    await once(target, 'spawn')
    const closed = once(target, 'close')
    async function receive(pattern: RegExp): Promise<RegExpMatchArray> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const match = stdout.match(pattern)
        if (match) return match
        if (target.exitCode !== null) break
        await delay(30)
      }
      throw new Error('Window fixture did not report ' + pattern)
    }
    const request = (created: number, expected: string) => spawnSync(entry,
      ['--kevin-close-launcher-window', String(target.pid), String(created), expected],
      { cwd, windowsHide: true, encoding: 'utf8', timeout: 3000 })
    try {
      const created = Number((await receive(/ready:(\d+)\r?\n/))[1])
      for (const [time, expected] of [[created + 1, image], [created, join(cwd, basename(image))]] as const) {
        const rejected = request(time, expected)
        expect(rejected.error).toBeUndefined()
        expect(rejected.status).toBe(1)
        expect(rejected.stdout).toBe('')
        expect(rejected.stderr).toContain('process identity changed')
      }
      expect(stdout).not.toMatch(/close:|setup:/)
      const matched = request(created, image)
      expect(matched.error).toBeUndefined()
      expect(matched.status).toBe(0)
      expect(matched.stdout.trim()).toBe('1')
      expect(matched.stderr).toBe('')
      await receive(new RegExp(message + 'Chrome_WidgetWin_1\\r?\\n'))
      expect(request(created, image).stdout.trim()).toBe('0')
      expect(target.exitCode).toBeNull()
      expect(stdout).not.toContain('KevinLauncherFixture_Other')
    } finally {
      if (target.exitCode === null && target.signalCode === null) target.kill()
      await closed
    }
  }, 10000)
})
