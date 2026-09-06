import { defineConfig, devices } from '@playwright/test'

const port = 4173
// An explicit IPv4 host, not `localhost`: on a machine where `localhost` resolves
// to `::1` first, `vite preview` binds only the IPv6 address and every request to
// `127.0.0.1` - including Playwright's own readiness check - is refused.
const host = '127.0.0.1'
const baseURL = `http://${host}:${String(port)}`

/** The one suite that inspects the built files rather than the rendered page. */
const ASSETS = /assets\.spec\.ts/

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
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: ASSETS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      testIgnore: ASSETS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 } },
    },
    {
      name: 'mobile',
      testIgnore: ASSETS,
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
      testIgnore: ASSETS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 760 } },
    },
    {
      // No viewport and no browser: this one reads `dist/`, which the web server
      // above has already built. Running it in the viewport projects would repeat
      // the same file reads four times over.
      name: 'assets',
      testMatch: ASSETS,
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --host ${host} --port ${String(port)} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
