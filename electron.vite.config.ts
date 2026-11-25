import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const buildIdentity = { __KEVIN_TRIAL_BUILD__: JSON.stringify(process.env.KEVIN_BUILD_IDENTITY === 'trial') }

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
    plugins: [react()]
  }
})
