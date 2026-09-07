import { describe, expect, it } from 'vitest'
import { capture, goSource } from '../test/goSource'
import {
  CHECK_AUTHORITY,
  CHECK_CODES,
  CHECK_FORMAT_VERSION,
  CHECK_MAX_NAMES,
  CHECK_PATH,
  CHECK_SOURCE,
} from './contract'

/**
 * The guard on `verify/contract.ts`.
 *
 * `internal/api` owns the path, the format version, the two provenance strings, and
 * every failure code. A client cannot derive any of them from a response, so they
 * are restated, and a restatement nothing checks drifts silently: a page that posts
 * to a path the server no longer serves gets a 404 it words as "this deployment
 * offers no fresh checks", and a page missing a failure code words a real refusal
 * as the vaguest thing it knows. `src/test/goSource.ts` says why this parses the Go
 * sources and why a parse that finds nothing fails.
 */

const configGo = goSource('internal/api/checkconfig.go')
const respondGo = goSource('internal/api/respond.go')

describe('the check constants the browser restates', () => {
  it('posts to the path Go serves', () => {
    expect(capture(configGo, 'PathCheck', /^const PathCheck = "([^"]+)"$/m)).toBe(CHECK_PATH)
  })

  it('accepts the format version Go writes', () => {
    expect(
      Number(capture(configGo, 'CheckFormatVersion', /^const CheckFormatVersion = (\d+)$/m)),
    ).toBe(CHECK_FORMAT_VERSION)
  })

  it('recognises the source Go declares', () => {
    expect(capture(configGo, 'CheckSource', /^const CheckSource = "([^"]+)"$/m)).toBe(CHECK_SOURCE)
  })

  it('recognises the authority Go declares', () => {
    expect(capture(configGo, 'CheckAuthority', /^const CheckAuthority = "([^"]+)"$/m)).toBe(
      CHECK_AUTHORITY,
    )
  })

  /*
   * Deliberately not equality. The server bound is one deployment's configuration
   * and can be set lower than the default, so the rule this page has to hold is
   * that its own selection bound never exceeds what an unconfigured deployment
   * accepts. A deployment that lowers it further refuses through `too_many_names`,
   * which `failure.ts` words as a selection to shrink.
   */
  it('never offers more names than an unconfigured deployment accepts', () => {
    const allowed = Number(
      capture(configGo, 'DefaultCheckMaxNames', /^\tDefaultCheckMaxNames\s*= (\d+)$/m),
    )
    expect(allowed).toBeGreaterThan(0)
    expect(CHECK_MAX_NAMES).toBeLessThanOrEqual(allowed)
  })
})

describe('the failure codes the browser words', () => {
  /**
   * The check block in `respond.go`, read as a block rather than code by code, so a
   * code added to Go and not here is a failure. Reading the whole block is the
   * point: a per-code assertion can only check the codes this file already knows.
   */
  const checkBlock = capture(
    respondGo,
    'the PathCheck failure codes',
    /\/\/ Failure codes for PathCheck\.[\s\S]*?\nconst \(\n([\s\S]*?)\n\)\n/,
  )

  // `\s*` before the `=` rather than one space: gofmt aligns a const block on its
  // longest name, so a name added to the block moves every other line's padding.
  const declared = [...checkBlock.matchAll(/^\tCode\w+\s*= "([^"]+)"$/gm)].map(([, code]) => code)

  it('reads a block with codes in it', () => {
    // Without this the two assertions below would both pass against a pattern that
    // matched a block and found nothing in it.
    expect(declared.length).toBeGreaterThan(5)
  })

  it('words every code the check path answers with', () => {
    for (const code of declared) {
      expect(CHECK_CODES).toContain(code)
    }
  })

  /*
   * The two shared request errors. `method_not_allowed` and `not_found` are declared
   * with the snapshot codes rather than in the check block, and `not_found` is what a
   * deployment that does not offer this endpoint answers, which the page has to be
   * able to say plainly rather than report as an outage.
   */
  it('words the two shared request errors', () => {
    for (const [name, pattern] of [
      ['CodeMethodNotAllowed', /^\tCodeMethodNotAllowed\s*= "([^"]+)"$/m],
      ['CodeNotFound', /^\tCodeNotFound\s*= "([^"]+)"$/m],
    ] as const) {
      expect(CHECK_CODES).toContain(capture(respondGo, name, pattern))
    }
  })

  it('names no code Go does not declare', () => {
    const shared = ['method_not_allowed', 'not_found']
    for (const code of CHECK_CODES) {
      if (shared.includes(code)) {
        continue
      }
      expect(declared).toContain(code)
    }
  })
})
