import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type WindowRole = 'app' | 'install' | 'uninstall' | 'viewer'

interface WindowOwner {
  role: WindowRole
  document: URL
  localPaths: readonly string[]
}

const owners = new WeakMap<WebContents, WindowOwner>()

function localWindowsPath(url: URL): string | undefined {
  if (process.platform !== 'win32' || url.protocol !== 'file:' || url.host) return undefined
  const path = fileURLToPath(url)
  return /^[a-z]:\\/i.test(path) ? path[0].toUpperCase() + path.slice(1) : undefined
}

function documentQuery(url: URL): string {
  const document = url.href.split('#', 1)[0]
  const start = document.indexOf('?')
  return start === -1 ? '' : document.slice(start)
}

function matchesDocument(input: string, owner: WindowOwner): boolean {
  try {
    const candidate = new URL(input)
    candidate.hash = ''
    if (candidate.href === owner.document.href) return true
    if (owner.localPaths.length && documentQuery(candidate) === documentQuery(owner.document)) {
      const path = localWindowsPath(candidate)
      return !!path && owner.localPaths.includes(path)
    }
  } catch {
    // No malformed URL or file path can inherit the window's privileges.
  }
  return false
}

/** Bind a window to the role and entry document selected by the main process. */
export function bindWindowRole(contents: WebContents, role: WindowRole, devUrl?: string): URL {
  const entry = devUrl ? new URL(devUrl) : pathToFileURL(join(__dirname, '../renderer/index.html'))
  const originalPath = localWindowsPath(entry)
  // Resolve only the trusted entry. Enrolling a renderer-supplied alias could
  // grant its surrounding directory or trigger access to an untrusted share.
  const resolvedPath = originalPath && realpathSync.native(originalPath)
  const target = resolvedPath ? pathToFileURL(resolvedPath) : entry
  if (resolvedPath) {
    target.search = documentQuery(entry)
    target.hash = entry.hash
  }
  const document = new URL(target.href)
  document.hash = ''
  const canonicalPath = localWindowsPath(document)
  const owner = { role, document, localPaths: originalPath && canonicalPath ? [originalPath, canonicalPath] : [] }
  owners.set(contents, owner)
  contents.on('will-navigate', (event, url) => {
    if (!matchesDocument(url, owner)) event.preventDefault()
  })
  return target
}

export function senderRole(event: IpcMainInvokeEvent): WindowRole | undefined {
  const owner = owners.get(event.sender)
  const frame = event.senderFrame
  if (owner && frame && frame === event.sender.mainFrame && matchesDocument(frame.url, owner)) {
    return owner.role
  }
  return undefined
}
