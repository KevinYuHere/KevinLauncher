import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Dependencies are bundled (not externalised) on purpose: the packaged app keeps
// its code in a versioned `resources/app-<version>/` directory that must be
// self-contained, because an update writes a whole new version directory while
// the launcher is running (see docs/INSTALLER.md). All runtime deps are small
// pure-JS packages, and `electron` + Node builtins stay external automatically.
export default defineConfig({
  main: {
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
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
