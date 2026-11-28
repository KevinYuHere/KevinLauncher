import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { clearLauncherLogs, flushLauncherLogs, launcherLogBytes, log } from '../src/main/services/logger'

it('bounds pending logs, rotates, redacts credentials and orders clearing with queued writes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-log-test-'))
  const file = join(root, 'launcher.log')
  const moduleApi = createRequire(import.meta.url)('node:module') as {
    _load: (request: string, ...rest: unknown[]) => unknown
  }
  const originalLoad = moduleApi._load
  const resolver = vi.spyOn(moduleApi, '_load').mockImplementation((request, ...rest) =>
    request === 'electron' ? { app: { getPath: () => root } } : originalLoad.call(moduleApi, request, ...rest)
  )
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    const max = 5 * 1024 * 1024
    await fs.writeFile(file, Buffer.alloc(max - 2))
    log('https://example.test/log?authkey=secret-url&other=1', { token: 'secret-object' })
    for (let i = 0; i < 380; i++) log(`message ${i}`)
    await flushLauncherLogs()
    expect((await fs.stat(file + '.1')).size).toBe(max - 2)
    const output = await fs.readFile(file, 'utf8')
    expect(output).toContain('124 lines dropped')
    expect(output).toContain('authkey=[redacted]&other=1')
    expect(output).not.toMatch(/secret-url|secret-object/)
    expect(consoleLog.mock.calls[0][0]).not.toMatch(/secret-url|secret-object/)
    log('before clear')
    const removed = clearLauncherLogs()
    log('after clear')
    const report = await removed
    expect(report.failures).toEqual([])
    expect(report.bytes).toBeGreaterThan(max)
    await flushLauncherLogs()
    expect(await fs.readFile(file, 'utf8')).toMatch(/after clear/)
    expect(await fs.readFile(file, 'utf8')).not.toMatch(/before clear/)
    expect(await launcherLogBytes()).toBe((await fs.stat(file)).size)
  } finally {
    resolver.mockRestore()
    consoleLog.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
