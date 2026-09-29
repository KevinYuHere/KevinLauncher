import { BrowserWindow, session, type Session } from 'electron'

const LOGIN_URL = 'https://user.hypergryph.com/userInfo'
const TOKEN_URL = 'https://web-api.hypergryph.com/account/info/hg'
const PARTITION = 'persist:hypergryph-login'

/** Pull the account token out of the `account/info/hg` response. */
function extractToken(text: string): string | null {
  const trimmed = text.trim()
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>
    const data = json.data as Record<string, unknown> | undefined
    const candidates = [data?.content, data?.token, json.content, json.token]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 10) return candidate
    }
  } catch {
    /* not JSON */
  }
  if (/^[A-Za-z0-9_\-.]{20,}$/.test(trimmed)) return trimmed
  return null
}

async function fetchTokenWithCookies(ses: Session): Promise<string | null> {
  const cookies = await ses.cookies.get({ domain: 'hypergryph.com' })
  if (cookies.length === 0) return null
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  try {
    const res = await fetch(TOKEN_URL, {
      headers: { Cookie: cookieHeader, 'User-Agent': 'Mozilla/5.0' }
    })
    return extractToken(await res.text())
  } catch {
    return null
  }
}

/**
 * Try to obtain a token silently from the persisted login session, without
 * showing any window. Returns null when the user is not logged in any more.
 */
export async function silentHypergryphToken(): Promise<string | null> {
  return fetchTokenWithCookies(session.fromPartition(PARTITION))
}

/**
 * Opens the Hypergryph account login page in a modal window. After the user
 * logs in, the account token is read automatically from the authenticated
 * session (no copy/paste needed) and returned.
 */
export async function loginHypergryphToken(parent: BrowserWindow | null): Promise<string> {
  const ses = session.fromPartition(PARTITION)

  const win = new BrowserWindow({
    width: 470,
    height: 760,
    parent: parent ?? undefined,
    modal: !!parent,
    title: '登录鹰角账号',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true }
  })
  win.setMenuBarVisibility(false)
  await win.loadURL(LOGIN_URL)

  return new Promise<string>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      clearInterval(poll)
      clearTimeout(timeout)
    }

    const finish = async (): Promise<void> => {
      if (settled) return
      const token = await fetchTokenWithCookies(ses)
      if (token) {
        settled = true
        cleanup()
        resolve(token)
        if (!win.isDestroyed()) win.close()
      }
    }

    const poll = setInterval(() => void finish(), 1500)
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('登录超时，请重试'))
      if (!win.isDestroyed()) win.close()
    }, 5 * 60 * 1000)

    win.webContents.on('did-navigate', () => void finish())
    win.webContents.on('did-navigate-in-page', () => void finish())
    win.on('closed', () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('登录已取消'))
    })
  })
}
