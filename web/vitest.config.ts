import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // tests/browser holds Playwright specs, which must not run under Vitest.
      exclude: ['tests/**', 'node_modules/**', 'dist/**'],
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
    },
  }),
)
