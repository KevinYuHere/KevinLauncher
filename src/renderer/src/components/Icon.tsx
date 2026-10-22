import type { ReactElement } from 'react'

// Inline 24×24 stroke icons (no icon-font / SVG spritesheet dependency). All
// paths inherit `currentColor`, so an icon always matches its button's colour.
export type IconName =
  | 'home'
  | 'gacha'
  | 'gallery'
  | 'update'
  | 'launcherUpdate'
  | 'settings'
  | 'plus'
  | 'stop'
  | 'clock'
  | 'modules'
  | 'chevronLeft'
  | 'chevronRight'
  | 'pause'
  | 'play'
  | 'chevronDown'
  | 'link'
  | 'grip'
  | 'check'
  | 'pencil'
  | 'folder'

interface IconProps {
  name: IconName
  size?: number
}

// Path data per icon name, rendered inside a 24×24 `viewBox`.
const PATHS: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.6V21h14V9.6" />
    </>
  ),
  gacha: (
    <>
      <path d="M12 2.5l2.3 7.2L21.5 12l-7.2 2.3L12 21.5l-2.3-7.2L2.5 12l7.2-2.3z" />
    </>
  ),
  gallery: (
    <>
      <rect x="3" y="4.5" width="18" height="15" />
      <circle cx="8.2" cy="9.5" r="1.6" />
      <path d="M21 15.5 15.5 10 8 18" />
    </>
  ),
  update: (
    <>
      <path d="M12 3v11" />
      <path d="M7.5 9.5 12 14l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  // Launcher self-update: deliberately different from the game-update icon above.
  launcherUpdate: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v6" />
      <path d="M9.2 10.8 12 13.6l2.8-2.8" />
    </>
  ),
  modules: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  stop: (
    <>
      <rect x="6" y="6" width="12" height="12" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  chevronLeft: (
    <>
      <path d="M15 5l-7 7 7 7" />
    </>
  ),
  chevronRight: (
    <>
      <path d="M9 5l7 7-7 7" />
    </>
  ),
  pause: (
    <>
      <rect x="6.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  play: (
    <>
      <path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" stroke="none" />
    </>
  ),
  chevronDown: (
    <>
      <path d="M5 9l7 7 7-7" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M8 12 5.8 14.2a3.4 3.4 0 0 0 4.8 4.8L13 16.8" />
      <path d="M16 12l2.2-2.2a3.4 3.4 0 0 0-4.8-4.8L11 7.2" />
    </>
  ),
  grip: (
    <>
      <path d="M8 7h8M8 12h8M8 17h8" />
    </>
  ),
  check: (
    <>
      <path d="M5 12.5 10 17.5 19 7" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 6.5h5.5l2 2.5h9.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </>
  )
}

/** Renders one of the built-in stroke icons at `size` px (defaults to 22). */
export default function Icon({ name, size = 22 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
