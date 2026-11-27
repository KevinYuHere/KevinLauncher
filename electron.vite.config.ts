import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const buildIdentity = { __KEVIN_TRIAL_BUILD__: 'false' }

/**
 * The Vite dev server injects the React refresh preamble as an inline module.
 * Keep the packaged HUD CSP strict and relax only that inline script plus the
 * HMR WebSocket while serving the same standalone `hud.html` in development.
 */
const hudDevCsp: Plugin = {
  name: 'kevin-hud-dev-csp',
  apply: 'serve',
  transformIndexHtml(html, context) {
    if (!/[\\/]hud\.html$/.test(context.filename)) return html
    return html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'none'", "connect-src 'self' ws: wss:")
  }
}

// Dependencies are bundled (not externalised) on purpose: the packaged app keeps
// its code in a versioned `resources/app-<version>/` directory that must be
// self-contained, because an update writes a whole new version directory while
// the launcher is running (see INSTALLATION.md). All runtime deps are small
// pure-JS packages, and `electron` + Node builtins stay external automatically.
export default defineConfig({
  main: {
    define: buildIdentity,
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          // Keep the launcher preload at out/preload/index.js.
          index: resolve('src/preload/index.ts'),
          // The isolated HUD preload is loaded only by the transparent overlay
          // window and never receives the launcher's privileged API.
          kevinHud: resolve('src/preload/kevinHud.ts')
        }
      }
    }
  },
  renderer: {
    define: buildIdentity,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), hudDevCsp],
    build: {
      rollupOptions: {
        input: {
          // Preserve out/renderer/index.html for the existing launcher roles and
          // emit the standalone HUD as out/renderer/hud.html.
          index: resolve('src/renderer/index.html'),
          hud: resolve('src/renderer/hud.html')
        }
      }
    }
  }
})
