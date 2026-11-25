import { expect, it } from 'vitest'
import { requireDiskSpace } from '../src/main/services/diskSpace'

it('adds simultaneous requirements on one volume and checks other volumes independently', async () => {
  const plan = [{ path: 'stage', bytes: 8 }, { path: 'merge', bytes: 6 }]
  const oneDrive = async () => ({ id: 'same', available: 10n })
  await expect(requireDiskSpace(plan, oneDrive)).rejects.toThrow(/磁盘空间不足.*14 字节.*10 字节/)
  await expect(requireDiskSpace(plan, async path => ({ id: path, available: 10n }))).resolves.toBeUndefined()
})

it('distinguishes unknown disk availability from a measured zero', async () => {
  const plan = [{ path: 'staging', bytes: 1 }]
  await expect(requireDiskSpace(plan, async () => { throw new Error('unavailable') }))
    .rejects.toThrow('无法确认目录所在磁盘的可用空间')
  await expect(requireDiskSpace(plan, async () => ({ id: 'measured', available: 0n })))
    .rejects.toThrow(/磁盘空间不足.*可用 0 字节/)
})
