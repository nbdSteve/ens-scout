import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { FIXTURE_SITE, VERIFY_SITE, type BuiltSite } from './servers'

/**
 * What the production builds actually ship.
 *
 * The browser is a presentation layer and nothing else: it reads one published
 * snapshot and asks the same read API to re-check a handful of names, and it has no
 * business holding a Graph endpoint, a Graph API key, an AWS credential, or a table
 * name. Vite inlines every `VITE_*` variable into the bundle, so a secret put in one
 * would be readable by anyone who opened the JavaScript. Reviewing the source for
 * that is not enough - the check has to be on the built artefact, which is what a
 * visitor downloads.
 *
 * Both bundles are scanned, not just the default one. The bundle with a read API
 * configured is the one that has a `VITE_*` value inlined at all, so it is the one
 * where a wrongly named variable would actually show up; scanning only the fixture
 * build would check the case that cannot leak.
 *
 * This suite reads the output directories, so it depends on the builds the Playwright
 * web servers have already run. It carries no viewport, which is why the config gives
 * it a project of its own instead of repeating it at every width.
 */

const SITES: readonly BuiltSite[] = [FIXTURE_SITE, VERIFY_SITE]

/*
 * `fileURLToPath`, not `URL.pathname`. The latter keeps the URL's leading slash, so on
 * Windows it yields `/C:/.../dist/`, which no filesystem call will open - and the
 * documented workflow for this package is PowerShell. `vite.config.ts` resolves its own
 * paths the same way.
 */
function distOf(site: BuiltSite): string {
  return fileURLToPath(new URL(`../../${site.outDir}/`, import.meta.url))
}

/** Every built file of one site, as a path relative to its output directory plus its text. */
async function builtFiles(site: BuiltSite): Promise<readonly (readonly [string, string])[]> {
  const dist = distOf(site)
  const entries = await readdir(dist, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  expect(files.length, `${site.outDir}/ is empty, so the build did not run`).toBeGreaterThan(0)

  return Promise.all(
    files.map(async (entry) => {
      const full = join(entry.parentPath, entry.name)
      return [`${site.outDir}/${relative(dist, full)}`, await readFile(full, 'utf8')] as const
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

for (const site of SITES) {
  test(`no file built into ${site.outDir}/ carries an endpoint, a key, or a credential`, async () => {
    const found: string[] = []
    for (const [path, text] of await builtFiles(site)) {
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(text)) {
          found.push(`${path} contains ${what}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  test(`the only origins ${site.outDir}/ names are ENS, its read API, and the page itself`, async () => {
    const origins = new Set<string>()
    for (const [, text] of await builtFiles(site)) {
      for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
        origins.add(match[0].toLowerCase())
      }
    }

    /*
     * `app.ens.domains` is where a visitor is sent to confirm a name, the two schema
     * URLs are namespaces in the built HTML, and `react.dev` is where React's own
     * minified error messages tell a developer to look. None of the three is a
     * request the page makes. The read API origin is the one that is, and it is the
     * one thing `VITE_*` is allowed to carry. Anything else would be the browser
     * talking to something it is not allowed to talk to.
     */
    const allowed = new Set([
      'https://app.ens.domains',
      'http://www.w3.org',
      'https://www.w3.org',
      'https://react.dev',
    ])
    if (site.apiBaseUrl !== null) {
      allowed.add(site.apiBaseUrl.toLowerCase())
    }
    expect([...origins].filter((origin) => !allowed.has(origin))).toEqual([])
  })

  test(`${site.outDir}/ ships the fixture, so a clean clone has something to show`, async () => {
    const files = await builtFiles(site)
    // Unquoted, because the minifier drops the quotes from a key that is already a
    // valid identifier. Asking for `"format_version"` would pass on the unminified
    // dev output and fail on the artefact that actually ships.
    const fixture = files.filter(([, text]) => /\bformat_version\s*:/.test(text))
    expect(fixture.length, 'no snapshot payload in the build').toBeGreaterThan(0)
  })
}

/*
 * The allowance above is only safe if the configured origin really is inlined, and it
 * is what makes the `verify` project's own bundle the one under test rather than a
 * second copy of the default one. Without this, a `build:verify` that silently lost
 * its environment would produce a fixture-mode bundle that passes every assertion
 * here and then fails nothing, because a page with no verifier has no check to make.
 */
test('the verifier build really does carry its configured read API', async () => {
  const configured = VERIFY_SITE.apiBaseUrl
  expect(configured, 'the verifier site has no read API to look for').not.toBeNull()

  const files = await builtFiles(VERIFY_SITE)
  const carrying = files.filter(([, text]) => text.includes(configured ?? ''))
  expect(carrying.length, 'VITE_API_BASE_URL did not reach dist-verify/').toBeGreaterThan(0)
})
