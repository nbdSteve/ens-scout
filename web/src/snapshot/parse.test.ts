import { describe, expect, it } from 'vitest'
import { buildSnapshotDocument } from '../test/factory'
import { parseSnapshotDocument, SnapshotFormatError } from './parse'

/**
 * Two structural promises the wire format makes, both of which fail quietly if the
 * reader gets them wrong.
 *
 * The canonical order is the publisher's, and the publisher is Go: a reader that
 * compares names its own way refuses scans that are perfectly in order, or accepts
 * ones that are not. And every timestamp in the payload has to be checked here rather
 * than by whoever reads it next, because a document that leaves this function is
 * treated as accepted from then on - it is what gets written to the local cache as the
 * offline fallback.
 */

/** A label outside the basic plane, and one inside it that sorts before it in UTF-8. */
const ROCKET = '\u{1f680}'
const IDEOGRAPH = '豈'

describe('parseSnapshotDocument canonical order', () => {
  it('accepts the order the publisher writes, including past the basic plane', () => {
    const document = buildSnapshotDocument({
      results: [
        { name: 'zzzz.eth', status: 'available' },
        { name: `${IDEOGRAPH}.eth`, status: 'available' },
        { name: `${ROCKET}.eth`, status: 'available' },
      ],
      sources: [{ id: 'one-letter', path: 'data/words/1-letters.txt', cadence: 'daily', names: 3 }],
    })

    // The browser's own comparison puts these in a different order, which is exactly
    // what used to make this valid snapshot unreadable.
    expect([`${IDEOGRAPH}.eth`, `${ROCKET}.eth`].sort()).toEqual([
      `${ROCKET}.eth`,
      `${IDEOGRAPH}.eth`,
    ])
    expect(parseSnapshotDocument(document).results.map((result) => result.name)).toEqual([
      'zzzz.eth',
      `${IDEOGRAPH}.eth`,
      `${ROCKET}.eth`,
    ])
  })

  it('still refuses results the publisher would never have written in that order', () => {
    const document = buildSnapshotDocument({
      results: [
        { name: `${ROCKET}.eth`, status: 'available' },
        { name: `${IDEOGRAPH}.eth`, status: 'available' },
      ],
      sources: [{ id: 'one-letter', path: 'data/words/1-letters.txt', cadence: 'daily', names: 2 }],
    })

    expect(() => parseSnapshotDocument(document)).toThrow(SnapshotFormatError)
  })

  it('refuses a duplicated name', () => {
    const document = buildSnapshotDocument({
      results: [
        { name: 'zap.eth', status: 'available' },
        { name: 'zap.eth', status: 'available' },
      ],
      sources: [
        { id: 'three-letters', path: 'data/words/3-letters.txt', cadence: 'daily', names: 2 },
      ],
    })

    expect(() => parseSnapshotDocument(document)).toThrow(SnapshotFormatError)
  })
})

describe('parseSnapshotDocument scan time', () => {
  it('refuses a scan time that is not a canonical UTC instant', () => {
    const document = buildSnapshotDocument()
    const broken = {
      ...document,
      metadata: { ...document.metadata, scanned_at: '2026-03-01 12:00:00' },
    }

    expect(() => parseSnapshotDocument(broken)).toThrow(/scanned_at/)
  })

  it('accepts the form the publisher writes', () => {
    const document = buildSnapshotDocument()
    expect(parseSnapshotDocument(document).metadata.scanned_at).toBe('2026-03-01T12:00:00Z')
  })
})
