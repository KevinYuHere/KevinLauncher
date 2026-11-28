import { DataError } from '@shared/dataErrors'

const active = new Map<Promise<void>, string>()
let exclusive: Promise<void> | undefined
let recoveryRequired: DataError | undefined
let generation = 0
let shuttingDown = false

/** These handlers acquire the gate after the user chooses a file or directory. */
const TRANSACTION_CHANNELS = new Set(['data:export', 'data:import', 'dataDir:set'])

export async function runWithDataAccess<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
  // Let a long-running game update settle if it was active when the gate closed.
  if (channel === 'update:cancel' || channel === 'window:close') return action()
  if (shuttingDown) throw new Error('启动器正在关闭')
  if (TRANSACTION_CHANNELS.has(channel)) return action()

  const admittedGeneration = generation
  while (exclusive) await exclusive
  if (shuttingDown) throw new Error('启动器正在关闭')
  if (recoveryRequired) throw recoveryRequired
  if (admittedGeneration !== generation) throw new DataError('DATA_MOVED', '数据目录已更换，请重新操作')
  const result = Promise.resolve().then(action)
  const done = result.then(() => undefined, () => undefined)
  active.set(done, channel)
  try {
    return await result
  } finally {
    active.delete(done)
  }
}

/** Reject requests submitted against the replaced files while the gate was closed. */
export function advanceDataGeneration(): void {
  generation += 1
}

/** Wait for already admitted operations and defer new ones until the transaction is over. */
export async function withExclusiveDataAccess<T>(action: () => Promise<T>): Promise<T> {
  if (shuttingDown) throw new Error('启动器正在关闭')
  if (recoveryRequired) throw recoveryRequired
  if (exclusive) throw new Error('正在导入或迁移数据，请稍后再试')
  if ([...active.values()].includes('update:start')) {
    throw new Error('请先完成或取消当前的游戏更新，再继续操作')
  }
  let release!: () => void
  exclusive = new Promise<void>((resolve) => { release = resolve })
  try {
    await Promise.all(active.keys())
    return await action()
  } finally {
    exclusive = undefined
    release()
  }
}

/** Close admissions before draining. Reopen if preparation fails and the launcher remains. */
export async function withShutdownDataAccess(
  cancelWork: () => Promise<void>,
  flush: () => Promise<void>
): Promise<void> {
  shuttingDown = true
  try {
    await cancelWork()
    await exclusive
    await Promise.all(active.keys())
    await flush()
  } catch (error) {
    shuttingDown = false
    throw error
  }
}

export function pendingDataTransfer(): Promise<void> | undefined {
  if (shuttingDown) return Promise.reject(new Error('启动器正在关闭'))
  if (recoveryRequired) return Promise.reject(recoveryRequired)
  return exclusive
}

export function requireDataRecovery(cause?: unknown): void {
  const details = cause instanceof Error ? `：${cause.message}` : ''
  recoveryRequired = new DataError('RECOVERY_REQUIRED', `数据需要恢复，请重启启动器${details}`, cause)
}

export function isDataRecoveryRequired(): boolean {
  return recoveryRequired !== undefined
}
