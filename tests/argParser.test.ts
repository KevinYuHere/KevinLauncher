import { describe, expect, it } from 'vitest'
import { splitArgs } from '../src/main/services/launcher'
import { windowsCommandLine } from '../src/main/services/windowsArguments'

describe('splitArgs', () => {
  it('round-trips Windows arguments with embedded quotes and trailing backslashes', () => {
    const args = ['', 'C:\\Program Files\\', 'a"b', 'two\\\\"quotes', "Kevin's", '包含 空格']
    expect(splitArgs(windowsCommandLine(args))).toEqual(args)
  })
  it('splits plain arguments', () => {
    expect(splitArgs('-a -b value')).toEqual(['-a', '-b', 'value'])
  })

  it('keeps double quoted arguments together', () => {
    expect(splitArgs('--name "hello world" -x')).toEqual(['--name', 'hello world', '-x'])
  })

  it('supports single quotes', () => {
    expect(splitArgs("--path 'C:\\Program Files\\game'")).toEqual([
      '--path',
      'C:\\Program Files\\game'
    ])
  })

  it('returns an empty array for blank input', () => {
    expect(splitArgs('   ')).toEqual([])
  })

  it('separates unquoted tabs and preserves quoted tabs', () => {
    expect(splitArgs('--name\t"hello\tworld"\t-x')).toEqual(['--name', 'hello\tworld', '-x'])
  })

  it('supports empty quoted strings', () => {
    expect(splitArgs('--flag ""')).toEqual(['--flag', ''])
  })
})
