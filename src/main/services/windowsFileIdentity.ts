import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { startPowerShell } from './powershell'

export interface FileIdentity {
  volumeId: bigint
  lowId: bigint
  highId: bigint
}

export interface HardLinkPlatform {
  driveFormat(path: string): Promise<string>
  fileIdentity(path: string, shareDelete: boolean): Promise<FileIdentity>
  close(): Promise<void>
}

// libuv exposes a 64-bit inode and Windows statfs has no filesystem type.
// Use the same Win32 file information and .NET drive format as Starward.
const API_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KevinFileIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    public struct FileId
    {
        public long VolumeId;
        public long FileIdLow;
        public long FileIdHigh;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle handle, int infoClass, out FileId identity, uint size);

    public static FileId Read(string path, bool shareDelete)
    {
        FileShare share = FileShare.ReadWrite;
        if (shareDelete) share |= FileShare.Delete;
        using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, share))
        {
            FileId identity;
            const int FileIdInfo = 18;
            if (!GetFileInformationByHandleEx(
                    stream.SafeFileHandle, FileIdInfo, out identity, (uint)Marshal.SizeOf(typeof(FileId))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return identity;
        }
    }
}
'@
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($null -ne ($line = $reader.ReadLine())) {
    $request = ConvertFrom-Json -InputObject $line
    $reply = @{ id = $request.id }
    try {
        if ($request.format) {
            $drive = [System.IO.DriveInfo]::new([string]$request.path)
            $reply.format = $drive.DriveFormat
        } else {
            $identity = [KevinFileIdentity]::Read([string]$request.path, [bool]$request.shareDelete)
            $reply.volumeId = $identity.VolumeId.ToString()
            $reply.fileIdLow = $identity.FileIdLow.ToString()
            $reply.fileIdHigh = $identity.FileIdHigh.ToString()
        }
    } catch {
        $reply.error = $_.Exception.Message
    }
    [Console]::WriteLine((ConvertTo-Json -Compress -InputObject $reply))
}
`

interface Reply {
  id: number
  format?: string
  volumeId?: string
  fileIdLow?: string
  fileIdHigh?: string
  error?: string
}

interface Pending {
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** A single helper per active updater task, started only on the first query. */
export class WindowsFileIdentity implements HardLinkPlatform {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 0
  private readonly pending = new Map<number, Pending>()

  private abort(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return
    this.child = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    child.stdin.destroy()
    if (child.exitCode === null) child.kill()
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = startPowerShell(API_SCRIPT)
    this.child = child
    child.stderr.resume()
    child.on('error', (error) => this.abort(child, error))
    child.stdin.on('error', (error) => this.abort(child, error))
    child.on('close', (code) => this.abort(child, new Error(`file identity helper exited (${code})`)))
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      if (this.child !== child) return
      let reply: Reply
      try {
        reply = JSON.parse(line) as Reply
      } catch {
        this.abort(child, new Error('invalid file identity reply'))
        return
      }
      if (!reply || typeof reply.id !== 'number') {
        this.abort(child, new Error('missing file identity reply id'))
        return
      }
      const awaiting = this.pending.get(reply.id)
      if (!awaiting) return
      this.pending.delete(reply.id)
      clearTimeout(awaiting.timer)
      if (reply.error) awaiting.reject(new Error(reply.error))
      else awaiting.resolve(reply)
    })
    return child
  }

  private query(data: { path: string; format?: true; shareDelete?: boolean }): Promise<Reply> {
    // The helper is a transport boundary. Avoid wedging the worker if spawning,
    // compilation, or UTF-8 communication fails before a reply is available.
    try {
      const child = this.child ?? this.start()
      const id = ++this.nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.abort(child, new Error('file identity helper timed out')), 15_000)
        this.pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ id, ...data })}\n`)
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  async driveFormat(path: string): Promise<string> {
    return (await this.query({ path, format: true })).format ?? ''
  }

  async fileIdentity(path: string, shareDelete: boolean): Promise<FileIdentity> {
    const { volumeId, fileIdLow, fileIdHigh } = await this.query({ path, shareDelete })
    if (volumeId === undefined || fileIdLow === undefined || fileIdHigh === undefined) {
      throw new Error('missing file identity fields')
    }
    return { volumeId: BigInt(volumeId), lowId: BigInt(fileIdLow), highId: BigInt(fileIdHigh) }
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 1000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
  }
}
