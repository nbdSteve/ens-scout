import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Reads Go sources, for the drift tests that guard every value the browser
 * restates from Go.
 *
 * Duplication that nothing checks drifts, and drifting silently is the bad case:
 * a client that accepts a format version Go no longer writes, or that measures a
 * three-hourly list against a daily interval, still renders a page. It just
 * renders a wrong one.
 *
 * These parse rather than execute, because the frontend gate must not need a Go
 * toolchain. A parse that finds nothing fails too: a renamed constant has to be
 * noticed here rather than quietly reduce a test to nothing.
 */

/*
 * A drift test runs under jsdom, where `import.meta.url` is an `http:` URL and
 * cannot be resolved to a path, so the repository is found by walking up to the
 * `go.mod` that declares the root module. That also makes the tests indifferent to
 * which directory the runner was started from.
 *
 * The nearest `go.mod` up is not the root: `web/` and `infra/` each hold one whose
 * only job is to prune that directory from the root module's package walk. Naming
 * the module is what tells those apart from the module that owns the Go sources
 * read here, and stopping at one of them would fail a drift test on a path that
 * does not exist rather than on a drift.
 */
const ROOT_MODULE = /^module\s+ens-scrape\s*$/m

function repositoryRoot(): string {
  let current = resolve(process.cwd())
  for (;;) {
    const candidate = join(current, 'go.mod')
    if (existsSync(candidate) && ROOT_MODULE.test(readFileSync(candidate, 'utf8'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(
        'no go.mod declaring the root module above the working directory, so the Go sources cannot be read',
      )
    }
    current = parent
  }
}

const root = repositoryRoot()

/** Reads one Go source, by its path from the repository root. */
export function goSource(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

/** The single capture of `pattern`, or a failure naming what went missing. */
export function capture(source: string, name: string, pattern: RegExp): string {
  const match = pattern.exec(source)
  if (match?.[1] === undefined) {
    throw new Error(
      `${name} was not found in the Go source. It was renamed or moved, and this test cannot check it any more.`,
    )
  }
  return match[1]
}
