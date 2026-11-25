import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

type ArchiveKind = 'package' | 'component' | 'plugin'

/** Extract through the system's seekable ZIP/7z reader, including manifest-ordered volumes. */
export async function extractHoYoArchive(
  paths: string[], destination: string, signal: AbortSignal, kind: ArchiveKind = 'package'
): Promise<void> {
  signal.throwIfAborted()
  if (!paths.length || (kind !== 'package' && paths.length !== 1)) throw new Error('游戏压缩包列表无效')
  const nativeDir = app.isPackaged ? join(__dirname, '../native') : join(app.getAppPath(), 'out/native')
  const child = spawn(join(nativeDir, 'KevinArchive.exe'), [kind, resolve(destination)], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']
  })
  let detail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { detail = (detail + text).slice(-2048) })
  const abort = (): void => { child.kill() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((done, fail) => {
      child.once('error', fail)
      child.once('close', code => {
        if (signal.aborted) fail(signal.reason)
        else if (code === 0) done()
        else fail(new Error('解压游戏文件失败：' + (detail.trim() || code)))
      })
      // An invalid executable or a cancelled child may close the input pipe
      // first. The process error or exit above supplies the definitive result.
      child.stdin.on('error', () => {})
      child.stdin.end(paths.map(path => resolve(path)).join('\n') + '\n', 'utf8')
      if (signal.aborted) abort()
    })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
