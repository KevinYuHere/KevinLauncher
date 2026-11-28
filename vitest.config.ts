import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Vitest does not read `electron.vite.config.ts`, so the `@shared` alias used by
// the main-process modules has to be declared here for tests that import them.
export default defineConfig({
  // Match the renderer's automatic React runtime (see tsconfig.web / the
  // @vitejs/plugin-react build) so .tsx modules do not expect a global React.
  esbuild: {
    jsx: 'automatic'
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
})
