import { describe, expect, it } from 'vitest'
import { CHECK_AUTHORITY, CHECK_FORMAT_VERSION, CHECK_SOURCE } from './contract'
import {
  CheckFormatError,
  CheckVersionError,
  assertCovers,
  parseCheckDocument,
  toVerification,
} from './parse'

/**
 * The check parser's job is to refuse. Every case here is a payload that must not
 * become a verification, because a verification is what opens the outbound link.
 */

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: CHECK_FORMAT_VERSION,
    source: CHECK_SOURCE,
    authority: CHECK_AUTHORITY,
    checked_at: '2026-03-01T12:00:00Z',
    expires_at: '2026-03-01T12:01:00Z',
    names: ['aaa.eth', 'bbb.eth'],
    results: [
      { name: 'aaa.eth', status: 'available' },
      {
        name: 'bbb.eth',
        status: 'registered',
        expiry: '2027-01-01T00:00:00Z',
        grace_ends: '2027-04-01T00:00:00Z',
        premium_ends: '2027-04-22T00:00:00Z',
      },
    ],
    advisory: 'Confirm availability and price with ENS before registering.',
    ...overrides,
  }
}

describe('parseCheckDocument', () => {
  it('accepts a well-formed answer', () => {
    const parsed = parseCheckDocument(document())
    expect(parsed.names).toEqual(['aaa.eth', 'bbb.eth'])
    expect(parsed.results).toHaveLength(2)
    expect(parsed.checked_at).toBe('2026-03-01T12:00:00Z')
  })

  it('refuses an unknown format version with its own error', () => {
    const cause = (): unknown => parseCheckDocument(document({ format_version: 2 }))
    expect(cause).toThrow(CheckVersionError)
    // The distinction from every other refusal: only this one needs a new bundle.
    expect(cause).toThrow(/version 2/)
  })

  /*
   * The check parser must not raise the snapshot parser's error class. `useSnapshot`
   * deletes a locally stored snapshot when it sees one, so a refused check sharing
   * that class would throw away a visitor's offline copy.
   */
  it('raises an error the snapshot loader does not recognise', async () => {
    const { SnapshotFormatError } = await import('../snapshot/parse')
    let raised: unknown
    try {
      parseCheckDocument(document({ format_version: 99 }))
    } catch (cause) {
      raised = cause
    }
    expect(raised).toBeInstanceOf(CheckFormatError)
    expect(raised).not.toBeInstanceOf(SnapshotFormatError)
  })

  it.each([
    ['a source it does not know', { source: 'some-other-index' }],
    ['an authority it does not know', { authority: 'this-website' }],
    ['a missing advisory', { advisory: '' }],
    ['a non-UTC checked instant', { checked_at: '2026-03-01T12:00:00+01:00' }],
    ['a fractional checked instant', { checked_at: '2026-03-01T12:00:00.500Z' }],
    ['an expiry before the check', { expires_at: '2026-03-01T11:59:00Z' }],
    ['an expiry equal to the check', { expires_at: '2026-03-01T12:00:00Z' }],
    ['no names at all', { names: [], results: [] }],
    ['a name that is not a .eth name', { names: ['aaa.com', 'bbb.eth'] }],
    ['an uppercase name', { names: ['AAA.eth', 'bbb.eth'] }],
    ['names out of canonical order', { names: ['bbb.eth', 'aaa.eth'] }],
    ['a duplicated name', { names: ['aaa.eth', 'aaa.eth'] }],
    [
      'an unknown status',
      {
        results: [
          { name: 'aaa.eth', status: 'maybe' },
          { name: 'bbb.eth', status: 'available' },
        ],
      },
    ],
  ])('refuses %s', (_what, overrides) => {
    expect(() => parseCheckDocument(document(overrides))).toThrow(CheckFormatError)
  })

  it('refuses fewer results than names', () => {
    expect(() =>
      parseCheckDocument(document({ results: [{ name: 'aaa.eth', status: 'available' }] })),
    ).toThrow(/holds 1 results but the answer covers 2 names/)
  })

  it('refuses more results than names', () => {
    expect(() =>
      parseCheckDocument(
        document({
          results: [
            { name: 'aaa.eth', status: 'available' },
            { name: 'bbb.eth', status: 'available' },
            { name: 'ccc.eth', status: 'available' },
          ],
        }),
      ),
    ).toThrow(CheckFormatError)
  })

  /*
   * The case the index comparison exists for: the right number of results, every one
   * of them well-formed, but a status attached to the wrong name.
   */
  it('refuses a result whose name is not the one at its position', () => {
    expect(() =>
      parseCheckDocument(
        document({
          results: [
            { name: 'bbb.eth', status: 'available' },
            { name: 'aaa.eth', status: 'available' },
          ],
        }),
      ),
    ).toThrow(/not the name at the same position/)
  })

  it('refuses a substituted name', () => {
    expect(() =>
      parseCheckDocument(
        document({
          results: [
            { name: 'aaa.eth', status: 'available' },
            { name: 'zzz.eth', status: 'available' },
          ],
        }),
      ),
    ).toThrow(/not the name at the same position/)
  })

  it('refuses a boundary with no expiry to have come from', () => {
    expect(() =>
      parseCheckDocument(
        document({
          results: [
            { name: 'aaa.eth', status: 'available' },
            { name: 'bbb.eth', status: 'grace-period', grace_ends: '2027-04-01T00:00:00Z' },
          ],
        }),
      ),
    ).toThrow(/without an expiry/)
  })

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'a string', 42, [], true]) {
      expect(() => parseCheckDocument(value)).toThrow(CheckFormatError)
    }
  })
})

describe('assertCovers', () => {
  it('accepts the exact set that was asked about', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['aaa.eth', 'bbb.eth'])
    }).not.toThrow()
  })

  it('accepts a request in a different order', () => {
    // The endpoint sorts and deduplicates, so the page compares the same way rather
    // than requiring a caller to have pre-sorted its selection.
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['bbb.eth', 'aaa.eth'])
    }).not.toThrow()
  })

  it('accepts a request with duplicates', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['bbb.eth', 'aaa.eth', 'bbb.eth'])
    }).not.toThrow()
  })

  it('refuses an answer that covers a name that was not asked about', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['aaa.eth'])
    }).toThrow(/covers 2 names but 1 were asked about/)
  })

  it('refuses an answer that omits a name that was asked about', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['aaa.eth', 'bbb.eth', 'ccc.eth'])
    }).toThrow(/covers 2 names but 3 were asked about/)
  })

  it('refuses an answer that substitutes a name of the same count', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), ['aaa.eth', 'ccc.eth'])
    }).toThrow(/does not cover "ccc.eth"/)
  })

  it('refuses a check for no names', () => {
    expect(() => {
      assertCovers(parseCheckDocument(document()), [])
    }).toThrow(CheckFormatError)
  })
})

describe('toVerification', () => {
  it('resolves the instants and the labels without deriving a status', () => {
    const view = toVerification(parseCheckDocument(document()))
    expect(view.checkedAt.toISOString()).toBe('2026-03-01T12:00:00.000Z')
    expect(view.expiresAt.toISOString()).toBe('2026-03-01T12:01:00.000Z')
    expect(view.results.map((result) => result.label)).toEqual(['aaa', 'bbb'])
    expect(view.results[0]?.status).toBe('available')
    expect(view.results[0]?.expiry).toBeNull()
    expect(view.results[1]?.premiumEnds?.toISOString()).toBe('2027-04-22T00:00:00.000Z')
  })
})
