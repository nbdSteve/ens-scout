/**
 * The two production builds the browser suite runs against.
 *
 * Shared by `playwright.config.ts`, which starts the servers, and by
 * `assets.spec.ts`, which reads the directories they were built from. A copied
 * literal in either place would let the suite pass while pointing at the wrong
 * bundle, and the origins assertion in `assets.spec.ts` turns on knowing exactly
 * which URL was configured into which build.
 */

/**
 * An explicit IPv4 host, not `localhost`. On a machine where `localhost` resolves to
 * `::1` first, `vite preview` binds only the IPv6 address and every request to
 * `127.0.0.1` - including Playwright's own readiness check - is refused.
 */
export const HOST = '127.0.0.1'

export interface BuiltSite {
  /** Output directory, relative to `web/`. */
  readonly outDir: string
  readonly port: number
  readonly baseURL: string
  /** Read API origin built into the bundle, or null for fixture mode. */
  readonly apiBaseUrl: string | null
}

function site(outDir: string, port: number, withApi: boolean): BuiltSite {
  const baseURL = `http://${HOST}:${String(port)}`
  return { outDir, port, baseURL, apiBaseUrl: withApi ? baseURL : null }
}

/** No read API, so the committed fixture and no verifier. The default build. */
export const FIXTURE_SITE = site('dist', 4173, false)

/**
 * A read API configured at its own origin, so the tick boxes and the outbound links
 * exist. The origin is the page's own, so a route Playwright fulfils is same-origin
 * and CORS never enters into it.
 */
export const VERIFY_SITE = site('dist-verify', 4174, true)
