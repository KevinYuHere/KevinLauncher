import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'

export interface SpaceNeed {
  path: string
  bytes: number
}

interface VolumeCapacity {
  id: string
  available: bigint
}

async function volumeCapacity(target: string): Promise<VolumeCapacity> {
  let candidate = resolve(target)
  for (;;) {
    try {
      const canonical = await fs.realpath(candidate)
      const [stat, volume] = await Promise.all([
        fs.stat(canonical, { bigint: true }), fs.statfs(canonical, { bigint: true })
      ])
      const allocationUnit = 'frsize' in volume && typeof volume.frsize === 'bigint' && volume.frsize > 0n
        ? volume.frsize : volume.bsize
      return { id: stat.dev.toString(), available: volume.bavail * allocationUnit }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(candidate) === candidate) throw error
      candidate = dirname(candidate)
    }
  }
}

export async function availableSpace(path: string): Promise<number | null> {
  try {
    return Number((await volumeCapacity(path)).available)
  } catch {
    return null
  }
}

/** Combine simultaneously needed bytes only when targets resolve to the same volume. */
export async function requireDiskSpace(
  needs: readonly SpaceNeed[],
  measure: (path: string) => Promise<VolumeCapacity> = volumeCapacity
): Promise<void> {
  const volumes = new Map<string, { required: bigint; available: bigint; path: string }>()
  for (const need of needs) {
    if (!Number.isSafeInteger(need.bytes) || need.bytes < 0) throw new Error('无法计算更新需要的磁盘空间')
    if (need.bytes === 0) continue
    let volume: VolumeCapacity
    try {
      volume = await measure(need.path)
    } catch {
      throw new Error('无法确认目录所在磁盘的可用空间：' + need.path)
    }
    const previous = volumes.get(volume.id)
    volumes.set(volume.id, {
      required: (previous?.required ?? 0n) + BigInt(need.bytes),
      available: previous && previous.available < volume.available ? previous.available : volume.available,
      path: need.path
    })
  }
  for (const volume of volumes.values()) {
    if (volume.required > volume.available) {
      throw new Error(`磁盘空间不足：${volume.path}，需 ${volume.required} 字节，可用 ${volume.available} 字节`)
    }
  }
}
