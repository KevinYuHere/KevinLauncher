import { describe, expect, it } from 'vitest'
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
})

describe('psQuote', () => {
  it('escapes embedded single quotes', () => {
    expect(psQuote("it's")).toBe("'it''s'")
  })
})
