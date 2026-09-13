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
    /*
     * The optional model library is deliberately one large chunk, reached only through
     * the dynamic import in `src/suggest/engine/load.ts` and only after a visitor has
     * been shown its size. Rollup's default 500 kB warning is about the bundle a first
     * screen waits for, and this chunk is not on that path, so the warning here would be
     * a line of noise on every build that trained everyone to ignore the next real one.
     *
     * Raised rather than silenced, and the figure that actually matters is asserted
     * instead of warned about: `tests/browser/assets.spec.ts` bounds the entry chunk and
     * insists the model hosts appear in nothing but this chunk. A soft warning nobody
     * reads is worse than a hard gate, so the gate is where the check lives.
     */
    chunkSizeWarningLimit: 7_000,
  },
})
