const active = new Map<Promise<void>, string>()
let exclusive: Promise<void> | undefined
let recoveryRequired = false

/** These handlers acquire the gate after the user chooses a file or directory. */
const TRANSACTION_CHANNELS = new Set(['data:import', 'dataDir:set'])

export async function runWithDataAccess<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
  if (TRANSACTION_CHANNELS.has(channel)) return action()

  // Let a long-running game update settle if it was active when the gate closed.
  if (channel === 'update:cancel' || channel === 'window:close') return action()

  while (exclusive) await exclusive
  if (recoveryRequired) throw new Error('请重启启动器以恢复原数据')
  const result = Promise.resolve().then(action)
  const done = result.then(() => undefined, () => undefined)
  active.set(done, channel)
  try {
    return await result
  } finally {
    active.delete(done)
  }
}

/** Wait for already admitted operations and defer new ones until the transaction is over. */
export async function withExclusiveDataAccess<T>(action: () => Promise<T>): Promise<T> {
  if (recoveryRequired) throw new Error('请重启启动器以恢复原数据')
  if (exclusive) throw new Error('正在导入或迁移数据，请稍后再试')
  if ([...active.values()].includes('update:start')) {
    throw new Error('请先完成或取消当前的游戏更新，再处理用户数据')
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

export async function waitForDataTransfer(): Promise<void> {
  await exclusive
}

export function pendingDataTransfer(): Promise<void> | undefined {
  if (recoveryRequired) return Promise.reject(new Error('请重启启动器以恢复原数据'))
  return exclusive
}

export function requireDataRecovery(): void {
  recoveryRequired = true
}

export function isDataRecoveryRequired(): boolean {
  return recoveryRequired
}
