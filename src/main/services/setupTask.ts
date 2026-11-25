let active = false

export function setupTaskActive(): boolean {
  return active
}

/** Hold the setup window open until its filesystem and system writes settle. */
export async function runSetupTask<T>(task: () => Promise<T>): Promise<T> {
  if (active) throw new Error('安装或卸载操作正在进行')
  active = true
  try {
    return await task()
  } finally {
    active = false
  }
}
