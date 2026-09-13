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
 * The optional model is the one thing here that does name a third-party origin, and the
 * whole arrangement in `suggest/` exists to confine it to one lazily fetched chunk. That
 * makes the split an assertion rather than a convention: the model hosts are allowed in
 * the model chunk and are forbidden in every other built file, so a static import that
 * pulled the library onto the first-screen path would fail here.
 *
 * This suite reads the output directories, so it depends on the builds the Playwright
 * web servers have already run. It carries no viewport, which is why the config gives
 * it a project of its own instead of repeating it at every width.
 */

const SITES: readonly BuiltSite[] = [FIXTURE_SITE, VERIFY_SITE]

/**
 * The lazily fetched model chunk, and its source map.
 *
 * Named from the module `suggest/engine/load.ts` imports, which is what Vite names the
 * chunk after. `tests/browser/suggestModel.ts` intercepts the same shape of path, so a
 * rename that broke this would break that too rather than quietly widening either.
 */
const MODEL_CHUNK = /\/assets\/webllm-[^/]+\.js(?:\.map)?$/

/** The executable half of it, without the source map. */
const MODEL_CODE = /\/assets\/webllm-[^/]+\.js$/

/**
 * Where the pinned model's assets and the library's own catalogue live.
 *
 * Not a secret and not a credential - they are published, public, and fetched by the
 * browser only after a visitor has been shown the size and has not refused it. What
 * matters is that they are reachable from nowhere except the chunk below.
 */
const MODEL_HOSTS: readonly string[] = [
  'https://huggingface.co',
  'https://raw.githubusercontent.com',
  // The library's own diagnostic link, in a message it never reaches here.
  'https://webgpureport.org',
]

/**
 * Origins that appear only in the model chunk's source map.
 *
 * A source map holds the library's vendored sources verbatim, comments and all, so these
 * are licence headers, specification links, and one author's own pages. None of them is
 * reachable from any code path: the executable chunk is checked against `MODEL_HOSTS`
 * alone, which is what `confines the model hosts` and the entry-chunk bound below turn on,
 * and this list is only about text nothing executes.
 *
 * It is an explicit list rather than a blanket exemption for `.map` files, because the
 * point of the origins check is to notice an endpoint arriving in a dependency. A map that
 * grew a new origin still fails here and has to be read and accepted.
 */
const MODEL_SOURCE_COMMENT_ORIGINS: readonly string[] = [
  'https://github.com',
  'http://www.apache.org',
  'https://en.cppreference.com',
  'https://jackpordi.com',
  'https://www.linkedin.com',
  'https://developer.chrome.com',
]

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

    const found: string[] = []
    for (const [path, text] of await builtFiles(site)) {
      /*
       * The model chunk may name the model hosts, and only it may. Its source map may also
       * carry the origins its vendored sources mention in comments, which nothing executes
       * and nothing fetches; the executable chunk is held to `MODEL_HOSTS` alone.
       */
      let permitted = allowed
      if (MODEL_CHUNK.test(path)) {
        permitted = new Set([
          ...allowed,
          ...MODEL_HOSTS,
          ...(MODEL_CODE.test(path) ? [] : MODEL_SOURCE_COMMENT_ORIGINS),
        ])
      }
      for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
        const origin = match[0].toLowerCase()
        if (!permitted.has(origin)) {
          found.push(`${path} names ${origin}`)
        }
      }
    }
    expect([...new Set(found)]).toEqual([])
  })

  /*
   * The other half of the same rule, stated from the other direction. The test above
   * would pass for a build that named no model host anywhere, which is also what a build
   * whose lazy chunk had been folded into the entry chunk looks like from a distance.
   * This one insists the hosts are somewhere, and that the somewhere is one chunk.
   */
  test(`${site.outDir}/ confines the model hosts to the lazily fetched chunk`, async () => {
    const naming = new Map<string, readonly string[]>()
    for (const [path, text] of await builtFiles(site)) {
      const hosts = MODEL_HOSTS.filter((host) => text.includes(host))
      if (hosts.length > 0) {
        naming.set(path, hosts)
      }
    }

    expect([...naming.keys()].length, 'no built file names the model host at all').toBeGreaterThan(
      0,
    )
    expect([...naming.keys()].filter((path) => !MODEL_CHUNK.test(path))).toEqual([])
  })

  /*
   * The promise the whole feature rests on, measured rather than asserted in prose: the
   * page a visitor waits for is the small one. The bound is generous against the current
   * figure so ordinary growth does not trip it, and it is far below the model chunk, which
   * is the comparison that matters - a static import of the library would multiply the
   * entry chunk by twenty and fail this by an order of magnitude rather than by a margin.
   */
  test(`the first screen of ${site.outDir}/ does not carry the model library`, async () => {
    const scripts = (await builtFiles(site)).filter(
      ([path]) => path.endsWith('.js') && !path.endsWith('.map'),
    )
    const entry = scripts.filter(([path]) => /\/assets\/index-[^/]+\.js$/.test(path))
    expect(entry.length, 'no entry chunk in the build').toBe(1)

    const bytes = Buffer.byteLength(entry[0]?.[1] ?? '', 'utf8')
    expect(bytes).toBeLessThan(600_000)
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
