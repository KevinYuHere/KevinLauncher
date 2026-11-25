import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type WindowRole = 'app' | 'install' | 'uninstall' | 'viewer'

const owners = new WeakMap<WebContents, { role: WindowRole; document: string }>()

function documentUrl(url: string): string {
  const document = new URL(url)
  document.hash = ''
  return document.href
}

/** Bind a window to the role and entry document selected by the main process. */
export function bindWindowRole(contents: WebContents, role: WindowRole, devUrl?: string): void {
  const document = documentUrl(devUrl || pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  owners.set(contents, { role, document })
  contents.on('will-navigate', (event, url) => {
    if (documentUrl(url) !== document) event.preventDefault()
  })
}

export function senderRole(event: IpcMainInvokeEvent): WindowRole | undefined {
  const owner = owners.get(event.sender)
  const frame = event.senderFrame
  if (owner && frame && frame === event.sender.mainFrame && documentUrl(frame.url) === owner.document) {
    return owner.role
  }
  return undefined
}
