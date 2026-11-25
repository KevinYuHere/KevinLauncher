import { spawn } from 'node:child_process'

export class TaskProcessExit extends Error {
  constructor(readonly code: number | null, detail: string) {
    super(detail || `子进程退出（${code ?? 'unknown'}）`)
  }
}

/** Cancellation settles after the process and its output channels have closed. */
export async function runTaskProcess(executable: string, args: string[], options: {
  signal?: AbortSignal
  cwd?: string
  windowsVerbatimArguments?: boolean
} = {}): Promise<void> {
  const { signal, ...launch } = options
  signal?.throwIfAborted()
  const child = spawn(executable, args, { ...launch, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  let failure: Error | undefined
  child.stderr.setEncoding('utf8').on('data', part => { output = (output + part).slice(-2048) })
  const abort = (): void => { child.kill() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', error => { failure = error })
      child.once('close', code => {
        if (signal?.aborted) reject(signal.reason)
        else if (failure) reject(failure)
        else if (code !== 0) reject(new TaskProcessExit(code, output.trim()))
        else resolve()
      })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
