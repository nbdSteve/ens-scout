/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Read API origin or path prefix. Empty selects the committed fixtures. */
  readonly VITE_API_BASE_URL?: string
  /** Which committed fixture to serve in fixture mode: `preview` or `stale`. */
  readonly VITE_FIXTURE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
