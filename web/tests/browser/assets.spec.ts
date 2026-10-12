import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { FIXTURE_SITE, VERIFY_SITE, type BuiltSite } from './servers'

/**
 * What the production builds actually ship.
 *
 * The browser is a presentation layer: it reads one published snapshot and asks the
 * same read API to re-check a handful of names. It has no business holding a Graph
 * endpoint, a Graph API key, an AWS credential, a table name, or a model runtime.
 * Vite inlines every `VITE_*` variable and ships source maps, so reviewing source alone
 * is not enough. These checks read the exact artefacts a visitor downloads.
 *
 * Both bundles are scanned. The bundle with a read API configured is the one that has a
 * `VITE_*` value inlined at all, so scanning only the fixture build would miss the case
 * that can leak one.
 *
 * This suite reads the output directories, so it depends on the builds the Playwright
 * web servers have already run. It carries no viewport, which is why the config gives it
 * a project of its own instead of repeating it at every width.
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
 * Strings that must not reach a visitor. Each is a literal rather than a pattern where
 * it can be, so a failure names exactly what leaked.
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

/**
 * Evidence that the removed in-browser model cannot return through a stale import,
 * transitive dependency, generated chunk, or source map.
 *
 * Paths are scanned with file contents so a chunk named after the old package fails even
 * if minification removes every readable symbol from its body. The host checks also keep
 * the origin allowlist below fail-closed.
 */
const REMOVED_MODEL_RUNTIME: readonly (readonly [string, RegExp])[] = [
  ['the WebLLM package', /@mlc-ai\/web-llm/i],
  ['a WebLLM chunk or symbol', /\bweb[-_]?llm\b/i],
  ['the removed model identifier', /SmolLM2-360M-Instruct-q4f16_1-MLC/i],
  ['the removed model host', /huggingface\.co|\bhf\.co\b/i],
  ['the removed shader-library host', /raw\.githubusercontent\.com/i],
  ['the removed WebGPU diagnostic host', /webgpureport\.org/i],
  ['the removed shader feature requirement', /shader-f16/i],
  ['the removed engine constructor', /CreateMLCEngine/],
  ['the removed model cache probe', /hasModelInCache/],
  ['the removed WebGPU adapter probe', /requestAdapter/i],
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
      for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
        const origin = match[0].toLowerCase()
        if (!allowed.has(origin)) {
          found.push(`${path} names ${origin}`)
        }
      }
    }
    expect([...new Set(found)]).toEqual([])
  })

  test(`${site.outDir}/ carries no removed WebLLM runtime or model asset reference`, async () => {
    const found: string[] = []
    for (const [path, text] of await builtFiles(site)) {
      const artefact = `${path}\n${text}`
      for (const [what, pattern] of REMOVED_MODEL_RUNTIME) {
        if (pattern.test(artefact)) {
          found.push(`${path} contains ${what}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  test(`${site.outDir}/ ships the complete compact rank within its transfer budgets`, async () => {
    const ranks = (await builtFiles(site)).filter(([path]) =>
      path.endsWith('/data/og-rank-v1.json'),
    )
    expect(ranks.length, 'the versioned rank artifact is missing or duplicated').toBe(1)

    const text = ranks[0]?.[1] ?? ''
    const document = JSON.parse(text) as {
      format_version?: unknown
      corpus?: { count?: unknown; sha256?: unknown }
      rubric_version?: unknown
      policy_version?: unknown
      generator_manifest_sha256?: unknown
      items?: unknown[]
    }
    expect(Object.keys(document).sort()).toEqual([
      'corpus',
      'format_version',
      'generator_manifest_sha256',
      'items',
      'policy_version',
      'rubric_version',
    ])
    expect(Object.keys(document.corpus ?? {}).sort()).toEqual(['count', 'sha256'])
    expect(document.format_version).toBe(1)
    expect(document.corpus?.count).toBe(19_051)
    expect(document.corpus?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(document.items).toHaveLength(19_051)
    expect(document.rubric_version).toBe('og-v1')
    expect(document.policy_version).toBe('featured-safe-v1')
    expect(document.generator_manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(document.items?.every((tuple) => Array.isArray(tuple) && tuple.length === 4)).toBe(true)

    const bytes = Buffer.from(text, 'utf8')
    const brotliBytes = brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength
    const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength
    expect(brotliBytes, 'rank artifact exceeds its 80 KiB Brotli budget').toBeLessThanOrEqual(
      80 * 1024,
    )
    expect(gzipBytes, 'rank artifact exceeds its 130 KiB gzip budget').toBeLessThanOrEqual(
      130 * 1024,
    )
  })

  /*
   * A production entry-point budget catches accidental dependency growth on the path
   * every visitor waits for. The bound is deliberately generous against the current
   * figure so ordinary feature work does not trip it.
   */
  test(`the entry JavaScript in ${site.outDir}/ stays within its production budget`, async () => {
    const scripts = (await builtFiles(site)).filter(
      ([path]) => path.endsWith('.js') && !path.endsWith('.map'),
    )
    const entry = scripts.filter(([path]) => /\/assets\/index-[^/]+\.js$/.test(path))
    expect(entry.length, 'no entry chunk in the build').toBe(1)

    const text = entry[0]?.[1] ?? ''
    const bytes = Buffer.byteLength(text, 'utf8')
    const gzipBytes = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).byteLength
    expect(bytes, 'entry JavaScript exceeds 350 KiB raw').toBeLessThanOrEqual(350 * 1024)
    expect(gzipBytes, 'entry JavaScript exceeds 110 KiB gzip').toBeLessThanOrEqual(110 * 1024)
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
