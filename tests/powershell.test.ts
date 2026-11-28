import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { psQuote, runPowerShell } from '../src/main/services/powershell'

const windows = process.platform === 'win32'

describe.skipIf(!windows)('runPowerShell', () => {
  it('returns non-ASCII output intact (forced UTF-8)', async () => {
    // Without forcing [Console]::OutputEncoding this comes back as mojibake.
    const out = await runPowerShell("Write-Output '华文中宋'")
    expect(out.trim()).toBe('华文中宋')
  })

  it('throws on a failing script', async () => {
    await expect(runPowerShell('throw "boom"')).rejects.toBeTruthy()
  })

  it('runs privileged system helpers with Windows-only paths and modules', async () => {
    const directory = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0')
    vi.stubEnv('PSModulePath', join(process.cwd(), 'custom-modules'))
    try {
      const result = await runPowerShell('(Get-Location).Path; $env:Path; $env:PSModulePath', { systemOnly: true })
      expect(result.trim().split(/\r?\n/).map(value => value.toLowerCase())).toEqual([
        directory, `${directory};${join(process.env.SystemRoot!, 'System32')}`, join(directory, 'Modules')
      ].map(value => value.toLowerCase()))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('psQuote', () => {
  it('escapes embedded single quotes', () => {
    expect(psQuote("it's")).toBe("'it''s'")
  })
})
