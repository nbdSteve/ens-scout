import { defineConfig, devices } from '@playwright/test'
import { FIXTURE_SITE, HOST, VERIFY_SITE, type BuiltSite } from './tests/browser/servers'

/** The one suite that inspects the built files rather than the rendered page. */
const ASSETS = /assets\.spec\.ts/

/** The one suite that needs a verifier, and the one the other projects cannot run. */
const VERIFY = /verify\.spec\.ts/

/*
 * Two production builds, on two ports.
 *
 * Fixture selection and `VITE_API_BASE_URL` are both build-time, so a browser test
 * cannot turn the verifier on at run time: whether the tick boxes and the outbound links
 * exist at all is decided by the bundle. That leaves two bundles as the only way to cover
 * both, and the split is deliberate rather than incidental - the four viewport projects
 * assert what a build with no read API does, which now includes that no name is a link,
 * and one bundle could not answer both questions.
 *
 * Nothing is served under `/api` by `vite preview`. Every test in the `verify` project
 * intercepts what it needs, and an un-intercepted request 404s rather than reaching
 * anything real.
 */
function server(target: BuiltSite, build: string, preview: string) {
  return {
    command: `npm run ${build} && npm run ${preview} -- --host ${HOST} --port ${String(target.port)} --strictPort`,
    url: target.baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  }
}

// The browser suite runs against a real production build served by `vite
// preview`, not the dev server, so what it asserts is what a visitor would get:
// the same minified bundle, the same asset graph, and the same absence of any
// Graph endpoint or credential.
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: { timeout: 5000 },
  use: {
    baseURL: FIXTURE_SITE.baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: [ASSETS, VERIFY],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      testIgnore: [ASSETS, VERIFY],
      use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 } },
    },
    {
      name: 'mobile',
      testIgnore: [ASSETS, VERIFY],
      use: { ...devices['Pixel 7'] },
    },
    {
      /*
       * WCAG 1.4.10 Reflow is written at 320 CSS pixels, so the narrowest supported
       * width is a viewport in its own right rather than something only checked by
       * hand. It is the width the layout is tightest at, and the one the responsive
       * rules in `index.css` exist for.
       *
       * Deliberately a desktop context and not a phone descriptor. A phone context
       * honours the viewport meta tag, so Chrome answers content that is too wide by
       * zooming the whole page out instead of scrolling it: the reflow check then
       * passes on a layout that really does overflow, which is exactly how a 320px
       * overflow went unnoticed here. A plain window at 320px cannot hide it.
       */
      name: 'narrow',
      testIgnore: [ASSETS, VERIFY],
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 760 } },
    },
    {
      /*
       * The verifier build, at one width. The fresh-check surface is a bar, a column of
       * tick boxes, and a second status in a cell the table already had, and the
       * responsive rules those live under are covered by the four viewport projects
       * against the other bundle. What this project is for is behaviour that exists only
       * when a read API is configured.
       *
       * Reduced motion, because a check moves things on screen - a button changes its
       * label, a banner appears, a row gains a status - and the requirement is that all
       * of it still works with animation turned off. It is the stricter of the two.
       */
      name: 'verify',
      testMatch: VERIFY,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: VERIFY_SITE.baseURL,
        contextOptions: { reducedMotion: 'reduce' },
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // No viewport and no browser: this one reads both output directories, which the
      // web servers above have already built. Running it in the viewport projects would
      // repeat the same file reads four times over.
      name: 'assets',
      testMatch: ASSETS,
    },
  ],
  webServer: [
    server(FIXTURE_SITE, 'build', 'preview'),
    /*
     * No `npm run build` here, so the typecheck is not run twice: the first server runs
     * it and both bundles come from the same sources. `VITE_API_BASE_URL` is read at
     * build time, which is why it is set on the command that builds the bundle.
     */
    {
      ...server(VERIFY_SITE, 'build:verify', 'preview:verify'),
      env: { VITE_API_BASE_URL: VERIFY_SITE.apiBaseUrl ?? '' },
    },
  ],
})
