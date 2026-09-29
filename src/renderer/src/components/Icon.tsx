import type { ReactElement } from 'react'

// Inline 24×24 stroke icons (no icon-font / SVG spritesheet dependency). All
// paths inherit `currentColor`, so an icon always matches its button's colour.
export type IconName =
  | 'home'
  | 'gacha'
  | 'gallery'
  | 'update'
  | 'settings'
  | 'plus'
  | 'stop'
  | 'clock'
  | 'chevronLeft'
  | 'chevronRight'

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
