import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const helper = join(process.cwd(), 'out', 'native', 'KevinHud.exe')
const source = join(process.cwd(), 'scripts', 'kevin-hud', 'KevinHud.cs')
const available = (() => {
  if (process.platform !== 'win32' || !existsSync(helper) || !existsSync(source)) return false
  try {
    return statSync(helper).mtimeMs >= statSync(source).mtimeMs
  } catch {
    return false
  }
})()

/**
 * The native helper's Present-selection self test uses only synthetic counter
 * sequences. It never starts ETW, opens a process, or requires elevation, so
 * it verifies the selected PID/rate independently of a running game.
 */
describe.skipIf(!available)('Kevin HUD native Present selection', () => {
  it('follows the Present-producing verified PID without double counting', () => {
    const output = execFileSync(helper, ['--selftest'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000
    })
    const line = output.trim().split(/\r?\n/).at(-1) ?? ''
    expect(JSON.parse(line)).toMatchObject({
      ok: true,
      selftest: 'present-selection',
      failures: 0
    })
  })
})
