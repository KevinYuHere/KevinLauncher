import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import type { SpecialAreaId, SpecialThemeId } from '@shared/types'
import { resolveAreaTheme, type ThemeAssignments } from '@shared/specialTheme'

/**
 * Theme assignments for the whole renderer. Components that need to change
 * *structure* (not just CSS) ask for their area's theme here — e.g. the rail
 * renders the star-core instead of the moving highlight. Everything that can be
 * expressed in CSS reads the `data-special-<area>` attributes instead.
 */
const SpecialThemeContext = createContext<ThemeAssignments>({})

export function SpecialThemeProvider({
  assignments,
  children
}: {
  assignments: ThemeAssignments
  children: ReactNode
}): ReactElement {
  return (
    <SpecialThemeContext.Provider value={assignments}>{children}</SpecialThemeContext.Provider>
  )
}

/** Resolve one area's theme (inside the App provider). */
export function useAreaTheme(area: SpecialAreaId): SpecialThemeId {
  return resolveAreaTheme(useContext(SpecialThemeContext), area)
}
