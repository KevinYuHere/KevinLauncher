import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ps } = vi.hoisted(() => ({ ps: vi.fn() }))
vi.mock('../src/main/services/powershell', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/services/powershell')>(), runPowerShell: ps
}))
vi.mock('../src/main/services/logger', () => ({ log() {} }))

const originalArgs = process.argv
beforeEach(() => {
  vi.resetModules()
  ps.mockReset()
  process.argv = [process.execPath]
})
afterEach(() => {
  vi.unstubAllEnvs()
  process.argv = originalArgs
})

describe.skipIf(process.platform !== 'win32')('Windows administrator startup', () => {
  it('continues an already elevated instance without a second prompt', async () => {
    ps.mockResolvedValue('True\r\n')
    const { ensureAdministrator } = await import('../src/main/services/elevation')
    expect(await ensureAdministrator('app')).toBe(true)
    expect(await ensureAdministrator('install')).toBe(true)
    expect(ps).toHaveBeenCalledTimes(1)
  })

  it('restarts the original portable wrapper with the selected directory and stops on cancellation', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', "D:\\安装 工具\\Kevin's Installer.exe")
    process.argv.push('--install-dir', 'D:\\我的 游戏\\')
    ps.mockResolvedValueOnce('false').mockRejectedValueOnce(new Error('用户取消'))
    const { ensureAdministrator } = await import('../src/main/services/elevation')
    expect(await ensureAdministrator('install')).toBe(false)
    expect(ps.mock.calls[1][0]).toContain("-FilePath 'D:\\安装 工具\\Kevin''s Installer.exe'")
    expect(ps.mock.calls[1][0]).toContain('"--install-dir" "D:\\我的 游戏\\\\"')
    expect(ps.mock.calls[1][0]).toContain('-Verb RunAs -ErrorAction Stop')
  })

  it('does not retry elevation when the verification failed or the elevated child still has a limited token', async () => {
    ps.mockRejectedValueOnce(new Error('token check failed'))
    let service = await import('../src/main/services/elevation')
    expect(await service.ensureAdministrator('install')).toBe(false)
    expect(ps).toHaveBeenCalledTimes(1)
    vi.resetModules()
    ps.mockResolvedValueOnce('false')
    process.argv.push('--kevin-elevation-requested')
    service = await import('../src/main/services/elevation')
    expect(await service.ensureAdministrator('app')).toBe(false)
    expect(ps).toHaveBeenCalledTimes(2)
  })

  it('preserves native argv across the legacy relaunch, including spaces, quotes and trailing slashes', async () => {
    const temp = await fs.mkdtemp(join(tmpdir(), 'kl-admin-args-'))
    try {
      const script = join(temp, '参数 with space.cjs')
      const result = join(temp, 'args.json')
      await fs.writeFile(script, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)))")
      const args = ['--tray', '--install-dir', "D:\\Kevin's 游戏\\", '', 'a"b', 'two\\\\"quotes']
      process.argv.push(script, result, ...args)
      const original = await vi.importActual<typeof import('../src/main/services/powershell')>('../src/main/services/powershell')
      ps.mockResolvedValueOnce('false').mockImplementationOnce((command: string) => {
        const verb = 'Start-Process -Verb RunAs -ErrorAction Stop '
        expect(command.startsWith(verb)).toBe(true)
        // Exercise real Windows argument parsing at the current token.
        return original.runPowerShell('Start-Process -Wait -WindowStyle Hidden -ErrorAction Stop ' + command.slice(verb.length))
      })
      const { ensureAdministrator } = await import('../src/main/services/elevation')
      expect(await ensureAdministrator('app')).toBe(false)
      expect(JSON.parse(await fs.readFile(result, 'utf8'))).toEqual([...args, '--kevin-elevation-requested'])
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
})
