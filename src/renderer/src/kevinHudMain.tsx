import { createRoot } from 'react-dom/client'
import KevinHudOverlay from './components/KevinHudOverlay'

/**
 * Standalone entry for `hud.html`.
 *
 * This page intentionally loads only the overlay and its own stylesheet. It
 * never imports `main.css`, initializes the launcher `App`, or performs page
 * network requests; the narrow `window.kevinHud` preload bridge supplies
 * frames pushed by the main process.
 */
const container = document.getElementById('root')
if (!container) throw new Error('Kevin HUD root element is missing')

createRoot(container).render(<KevinHudOverlay />)
