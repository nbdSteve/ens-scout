import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * What the production build actually ships.
 *
 * The browser is a presentation layer and nothing else: it reads one published
 * snapshot, and it has no business holding a Graph endpoint, a Graph API key, an
 * AWS credential, or a table name. Vite inlines every `VITE_*` variable into the
 * bundle, so a secret put in one would be readable by anyone who opened the
 * JavaScript. Reviewing the source for that is not enough - the check has to be on
 * the built artefact, which is what a visitor downloads.
 *
 * This suite reads `dist/`, so it depends on the build the Playwright web server
 * has already run. It carries no viewport, which is why the config gives it a
 * project of its own instead of repeating it at every width.
 */

const DIST = new URL('../../dist/', import.meta.url).pathname

/** Every built file, as a path relative to `dist/` paired with its text. */
async function builtFiles(): Promise<readonly (readonly [string, string])[]> {
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  expect(files.length, 'dist/ is empty, so the build did not run').toBeGreaterThan(0)

  return Promise.all(
    files.map(async (entry) => {
      const full = join(entry.parentPath, entry.name)
      return [relative(DIST, full), await readFile(full, 'utf8')] as const
    }),
  )
}

/**
 * Strings that must not reach a visitor. Each is a literal rather than a pattern
 * where it can be, so a failure names exactly what leaked.
 */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a Graph gateway endpoint', /gateway(-arbitrum)?\.thegraph\.com/i],
  ['a Graph subgraph endpoint', /api\.thegraph\.com/i],
  ['a Graph subgraph path', /\/subgraphs\/(id|name)\//i],
  ['a Graph API key variable', /THEGRAPH_API_KEY/],
  ['a DynamoDB endpoint', /dynamodb[.-][a-z0-9-]*\.amazonaws\.com/i],
  ['an AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['an AWS secret access key variable', /AWS_SECRET_ACCESS_KEY/],
  ['a GraphQL query for ENS registrations', /name_in\s*:/],
]

test('no built file carries an endpoint, a key, or a credential', async () => {
  const found: string[] = []
  for (const [path, text] of await builtFiles()) {
    for (const [what, pattern] of FORBIDDEN) {
      if (pattern.test(text)) {
        found.push(`${path} contains ${what}`)
      }
    }
  }
  expect(found).toEqual([])
})

test('the only origins the build names are ENS and the page itself', async () => {
  const origins = new Set<string>()
  for (const [, text] of await builtFiles()) {
    for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
      origins.add(match[0].toLowerCase())
    }
  }

  /*
   * `app.ens.domains` is where a visitor is sent to confirm a name, the two schema
   * URLs are namespaces in the built HTML, and `react.dev` is where React's own
   * minified error messages tell a developer to look. None of the three is a
   * request the page makes. Anything else would be the browser talking to
   * something it is not allowed to talk to.
   */
  const allowed = new Set([
    'https://app.ens.domains',
    'http://www.w3.org',
    'https://www.w3.org',
    'https://react.dev',
  ])
  expect([...origins].filter((origin) => !allowed.has(origin))).toEqual([])
})

test('the build ships the fixture, so a clean clone has something to show', async () => {
  const files = await builtFiles()
  // Unquoted, because the minifier drops the quotes from a key that is already a
  // valid identifier. Asking for `"format_version"` would pass on the unminified
  // dev output and fail on the artefact that actually ships.
  const fixture = files.filter(([, text]) => /\bformat_version\s*:/.test(text))
  expect(fixture.length, 'no snapshot payload in the build').toBeGreaterThan(0)
})
