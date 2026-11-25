// Worker thread that snapshots the running process tree (pid/parent/name).
// A `Get-CimInstance` call can block for a while, so it runs here instead of on
// the main process. The parent sends `{ id }` and receives the snapshot tagged
// with the same id.
import { parentPort } from 'worker_threads'
import { ProcessTree } from '../services/processTree'

interface Request {
  id: number
}

parentPort?.on('message', async (message: Request) => {
  try {
    parentPort?.postMessage({ id: message.id, ok: true, procs: await ProcessTree.snapshot() })
  } catch (error) {
    parentPort?.postMessage({ id: message.id, ok: false, error: (error as Error).message })
  }
})
