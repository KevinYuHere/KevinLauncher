import { app } from 'electron'
import { createAppearancePresetStore } from './appearancePresetStore'

/** Process-wide preset store, bound lazily to the current data directory. */
export const appearancePresets = createAppearancePresetStore(() => app.getPath('userData'))
