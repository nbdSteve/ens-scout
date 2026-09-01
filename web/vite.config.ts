import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The committed fixture snapshots live outside web/, so Vite needs explicit
// permission to read them. They are the only thing this app imports from the
// repository root, and they contain no credentials: see data/fixtures/.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs let the built site be served from any path, including a
  // CloudFront distribution behind a sub-path, without a rebuild.
  base: './',
  server: {
    fs: { allow: [repositoryRoot] },
  },
  build: {
    // A stale snapshot is a data problem, not a bundle problem: keep source maps
    // so a production bug can be diagnosed without guessing at minified frames.
    sourcemap: true,
    target: 'es2022',
  },
})
