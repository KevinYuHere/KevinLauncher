import { describe, expect, it, vi } from 'vitest'
import { advanceDataGeneration, runWithDataAccess, withExclusiveDataAccess } from '../src/main/ipc/dataAccess'

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

describe('data checkpoint coordination', () => {
  it('waits for old operations and closes admissions without waiting on the export itself', async () => {
    const prior = gate()
    const checkpoint = gate()
    const sequence: string[] = []
    const early = runWithDataAccess('apps:update', async () => {
      await prior.wait
      sequence.push('committed')
    })
    const snapshot = runWithDataAccess('data:export', () => withExclusiveDataAccess(async () => {
      sequence.push('snapshot')
      await checkpoint.wait
    }))
    const after = runWithDataAccess('wallpaper:remove', () => sequence.push('removed'))
    prior.open()
    await early
    await vi.waitFor(() => expect(sequence).toEqual(['committed', 'snapshot']))
    checkpoint.open()
    await Promise.all([snapshot, after])
    expect(sequence).toEqual(['committed', 'snapshot', 'removed'])
  })

  it('rejects waiting commands for the old data after replacement', async () => {
    const checkpoint = gate()
    const replaced = withExclusiveDataAccess(async () => {
      await checkpoint.wait
      advanceDataGeneration()
    })
    const write = vi.fn()
    const pending = runWithDataAccess('apps:update', write)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'DATA_MOVED' })
    checkpoint.open()
    await Promise.all([replaced, rejection])
    expect(write).not.toHaveBeenCalled()
    await runWithDataAccess('apps:update', write)
    expect(write).toHaveBeenCalledOnce()
  })
})
