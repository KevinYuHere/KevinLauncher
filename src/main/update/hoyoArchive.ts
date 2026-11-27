import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

type ArchiveKind = 'package' | 'component' | 'plugin'

/** Extract through the system's seekable ZIP/7z reader, including manifest-ordered volumes. */
export async function extractHoYoArchive(
  paths: string[], destination: string, signal: AbortSignal, kind: ArchiveKind = 'package'
): Promise<void> {
  await runArchive(paths, destination, signal, kind)
}

export async function gameArchiveBytes(paths: string[], destination: string, signal: AbortSignal): Promise<number> {
  const output = await runArchive(paths, destination, signal, 'measure')
  const size = Number(output.trim())
  if (!/^\d+$/.test(output.trim()) || !Number.isSafeInteger(size)) throw new Error('无法计算游戏压缩包大小')
  return size
}

async function runArchive(
  paths: string[], destination: string, signal: AbortSignal, kind: ArchiveKind | 'measure'
): Promise<string> {
  signal.throwIfAborted()
  if (!paths.length || ((kind === 'component' || kind === 'plugin') && paths.length !== 1)) {
    throw new Error('游戏压缩包列表无效')
  }
  const nativeDir = app.isPackaged ? join(__dirname, '../native') : join(app.getAppPath(), 'out/native')
  const child = spawn(join(nativeDir, 'KevinArchive.exe'), [kind, resolve(destination)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let detail = ''
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', text => { output = (output + text).slice(-256) })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { detail = (detail + text).slice(-2048) })
  const abort = (): void => { child.kill() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise<string>((done, fail) => {
      child.once('error', fail)
      child.once('close', code => {
        if (signal.aborted) fail(signal.reason)
        else if (code === 0) done(output)
        else if (detail.includes('KL_ARCHIVE_UNAVAILABLE')) {
          fail(new Error('当前 Windows 系统缺少游戏包需要的 ZIP/7z 解压能力（archiveint.dll）'))
        }
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
