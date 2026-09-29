// Helpers that turn stored file names / paths into `kevin-media://` URLs. The
// custom protocol is served by the main process (icon / brand / bg / file /
// default hosts), so the renderer never needs direct filesystem access.
export const VIDEO_RE = /\.(mp4|webm)$/i

/** URL for an app's stored icon file (relative to the `icons` folder). */
export function iconUrl(file: string | null): string | null {
  return file ? `kevin-media://icon/${file}` : null
}

export function backgroundUrl(file: string | null): string | null {
  return file ? `kevin-media://bg/${file}` : null
}

/** URL for the launcher's own (global) icon. */
export function brandUrl(file: string | null): string | null {
  return file ? `kevin-media://brand/${file}` : null
}

/** URL for the launcher's bundled default icon. */
export function defaultIconUrl(): string {
  return 'kevin-media://default/icon.png'
}

/** URL for an arbitrary absolute file path (used by the gallery / viewer). */
export function fileUrl(path: string): string {
  return `kevin-media://file/${encodePath(path)}`
}

function encodePath(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
