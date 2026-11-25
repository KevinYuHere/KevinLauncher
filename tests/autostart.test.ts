import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAutoStart } from '../src/main/services/autostart'

const mocks = vi.hoisted(() => ({
  task: vi.fn(),
  runKey: vi.fn(),
  readRunKey: vi.fn(),
  query: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: (_exe: string, args: string[], _options: unknown, done: (error: { code: number } | null) => void) =>
    void Promise.resolve(mocks.task(args)).then((code) => done(code === 0 ? null : { code }))
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, setLoginItemSettings: mocks.runKey, getLoginItemSettings: mocks.readRunKey }
}))
vi.mock('../src/main/services/powershell', () => ({ psQuote: (text: string) => text, runPowerShell: mocks.query }))
vi.mock('../src/main/services/buildIdentity', () => ({ trialBuild: false }))
vi.mock('../src/main/services/logger', () => ({ log: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.task.mockResolvedValue(0)
  mocks.readRunKey.mockReturnValue({ openAtLogin: false })
  mocks.query.mockResolvedValue('')
})

describe('Windows startup settings', () => {
  it('applies requests in order and reports their actual mechanism', async () => {
    let create!: (code: number) => void
    mocks.task.mockImplementationOnce(() => new Promise<number>((resolve) => { create = resolve }))
    const older = applyAutoStart('tray', 'D:\\测试 目录\\KevinLauncher.exe')
    const newer = applyAutoStart('off')
    await vi.waitFor(() => expect(mocks.task).toHaveBeenCalledOnce())
    expect(mocks.task.mock.calls[0][0]).toContain('"D:\\测试 目录\\KevinLauncher.exe" --tray')
    create(0)
    await expect(older).resolves.toEqual({ requested: 'tray', mechanism: 'scheduled-task' })
    await expect(newer).resolves.toEqual({ requested: 'off', mechanism: 'disabled' })
    expect(mocks.task.mock.calls.map(([args]) => args[0])).toEqual(['/Create', '/Delete'])
  })

  it('reports an existing task that cannot be removed', async () => {
    mocks.task.mockResolvedValue(1)
    mocks.query.mockResolvedValue('KevinLauncher')
    await expect(applyAutoStart('off')).rejects.toThrow('Windows 计划任务无法删除')
    expect(mocks.runKey).not.toHaveBeenCalled()
  })

  it('reports the Run key fallback only after readback agrees', async () => {
    mocks.task.mockResolvedValue(1)
    mocks.readRunKey.mockReturnValue({ openAtLogin: true })
    await expect(applyAutoStart('window')).resolves.toEqual({ requested: 'window', mechanism: 'run-key' })
    mocks.readRunKey.mockReturnValue({ openAtLogin: false })
    await expect(applyAutoStart('window')).rejects.toThrow('Windows 启动项状态未生效')
  })
})
