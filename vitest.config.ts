import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Vitest does not read `electron.vite.config.ts`, so the `@shared` alias used by
// the main-process modules has to be declared here for tests that import them.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
})
