import { describe, expect, it } from 'vitest'
import { errorReason, failureText } from '../src/renderer/src/format'

describe('renderer error reasons', () => {
  it('unwraps Electron IPC errors and leading Error labels', () => {
    const error = new Error("Error invoking remote method 'gallery:list': Error: 截图目录不可用")
    expect(errorReason(error)).toBe('截图目录不可用')
    expect(failureText(error, '读取截图目录失败。')).toBe('读取截图目录失败。 详情：截图目录不可用')
  })

  it('reuses a data error message without its code or IPC wrapper', () => {
    const error = new Error("Error invoking remote method 'config:save': Error: [SAVE_FAILED] 配置保存失败")
    expect(errorReason(error)).toBe('配置保存失败')
  })

  it('omits an empty reason instead of printing undefined or null', () => {
    const empty = new Error("Error invoking remote method 'update:check': Error: ")
    expect(errorReason(empty)).toBe('')
    expect(failureText(empty, '检查更新失败。')).toBe('检查更新失败。')
    expect(failureText(null, '读取失败。')).toBe('读取失败。')
    expect(failureText(undefined, '读取失败。')).toBe('读取失败。')
  })
})
