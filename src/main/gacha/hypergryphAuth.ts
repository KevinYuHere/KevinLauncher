import { BrowserWindow, session, type Session } from 'electron'

const LOGIN_URL = 'https://user.hypergryph.com/userInfo'
const TOKEN_URL = 'https://web-api.hypergryph.com/account/info/hg'
const PARTITION = 'persist:hypergryph-login'
const FETCH_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 1500
let loginFlight: Promise<string> | undefined
let silentFlight: Promise<string | null> | undefined
let cancelLogin: (() => void) | undefined

/** Pull the account token out of the `account/info/hg` response. */
function extractToken(text: string): string | null {
  const trimmed = text.trim()
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>
    if ([json.status, json.code].some((code) => code !== undefined && code !== 0)) return null
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

async function fetchTokenWithCookies(ses: Session, signal?: AbortSignal): Promise<string | null> {
  try {
    const cookies = await ses.cookies.get({ url: TOKEN_URL })
    if (cookies.length === 0) return null
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const res = await fetch(TOKEN_URL, {
      headers: { Cookie: cookieHeader, 'User-Agent': 'Mozilla/5.0' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error'
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    return extractToken(await res.text())
  } catch {
    return null
  }
}

/**
 * Try to obtain a token silently from the persisted login session, without
 * showing any window. Returns null when the user is not logged in any more.
 */
export function silentHypergryphToken(): Promise<string | null> {
  silentFlight ??= fetchTokenWithCookies(session.fromPartition(PARTITION)).finally(() => { silentFlight = undefined })
  return silentFlight
}

/**
 * Opens the Hypergryph account login page in a modal window. After the user
 * logs in, the account token is read automatically from the authenticated
 * session (no copy/paste needed) and returned.
 */
export function loginHypergryphToken(parent: BrowserWindow | null): Promise<string> {
  loginFlight ??= openLogin(parent).finally(() => { loginFlight = undefined })
  return loginFlight
}

export function cancelHypergryphLogin(): void {
  cancelLogin?.()
}

async function openLogin(parent: BrowserWindow | null): Promise<string> {
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
  return new Promise<string>((resolve, reject) => {
    const contents = win.webContents
    const controller = new AbortController()
    let settled = false
    let inFlight = false
    let pollTimer: NodeJS.Timeout | undefined

    function finish(error: Error | null, token?: string): void {
      if (settled) return
      settled = true
      cancelLogin = undefined
      controller.abort()
      clearTimeout(pollTimer)
      clearTimeout(timeout)
      win.removeListener('closed', onClosed)
      if (!contents.isDestroyed()) {
        contents.removeListener('did-navigate', poll)
        contents.removeListener('did-navigate-in-page', poll)
      }
      if (!win.isDestroyed()) win.close()
      if (error) reject(error)
      else resolve(token!)
    }

    function poll(): void {
      if (settled || inFlight) return
      clearTimeout(pollTimer)
      inFlight = true
      void fetchTokenWithCookies(ses, controller.signal).then((token) => {
        if (token) finish(null, token)
      }).finally(() => {
        inFlight = false
        if (!settled) pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
      })
    }

    const timeout = setTimeout(() => finish(new Error('登录超时，请重试')), LOGIN_TIMEOUT_MS)
    const onClosed = (): void => finish(new Error('登录已取消'))
    cancelLogin = onClosed
    win.once('closed', onClosed)
    contents.on('did-navigate', poll)
    contents.on('did-navigate-in-page', poll)
    void win.loadURL(LOGIN_URL).then(poll).catch(() => finish(new Error('无法打开鹰角登录页')))
  })
}
