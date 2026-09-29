import { describe, expect, it } from 'vitest'
import { ProcessTree, type ProcInfo } from '../src/main/services/processTree'

const snapshot: ProcInfo[] = [
  { pid: 1, ppid: 0, name: 'root.exe' },
  { pid: 2, ppid: 1, name: 'start.cmd' },
  { pid: 3, ppid: 1, name: 'other.exe' },
  { pid: 4, ppid: 2, name: 'game.exe' },
  { pid: 5, ppid: 4, name: 'child.exe' }
]

const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b)

describe('ProcessTree.descendants', () => {
  it('collects every transitive descendant including the root', () => {
    expect(sorted(ProcessTree.descendants(snapshot, 1))).toEqual([1, 2, 3, 4, 5])
  })

  it('collects a sub-tree (script -> game -> child)', () => {
    expect(sorted(ProcessTree.descendants(snapshot, 2))).toEqual([2, 4, 5])
  })

  it('returns the root itself when it has no children', () => {
    expect(ProcessTree.descendants(snapshot, 5)).toEqual([5])
  })

  it('returns the pid even when it is not present in the snapshot', () => {
    expect(ProcessTree.descendants(snapshot, 99)).toEqual([99])
  })
})
