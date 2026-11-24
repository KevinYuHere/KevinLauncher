import { describe, expect, it } from 'vitest'
import { splitArgs } from '../src/main/services/launcher'

describe('splitArgs', () => {
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
