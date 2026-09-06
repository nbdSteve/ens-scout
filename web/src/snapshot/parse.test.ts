import { describe, expect, it } from 'vitest'
import {
  buildLatestDocument,
  buildSnapshotDocument,
  SCANNED_AT,
  type SourceSpec,
} from '../test/factory'
import {
  assertPointerMatches,
  parseLatestDocument,
  parseSnapshotDocument,
  SnapshotFormatError,
  toSnapshot,
} from './parse'
import type { SnapshotDocument } from './types'

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

/**
 * Each source list carries the instant it was really scanned at, which is not the
 * snapshot's scan time: a publisher scans one group and carries the other group's
 * results forward, so a carried list keeps the older instant.
 *
 * Every rule here fails closed, and none of them substitutes the snapshot's scan
 * time for an instant that is missing or unusable. That substitution is the whole
 * defect the field exists to remove, so a document without it is malformed rather
 * than approximated.
 */
describe('parseSnapshotDocument source scan times', () => {
  const CARRIED = new Date(SCANNED_AT.getTime() - 20 * 60 * 60 * 1000)

  function withSources(sources: readonly SourceSpec[]): SnapshotDocument {
    return buildSnapshotDocument({
      results: [
        { name: 'aaaa.eth', status: 'available' },
        { name: 'bbbbb.eth', status: 'available' },
      ],
      sources,
    })
  }

  const SCANNED: SourceSpec = {
    id: 'four-letters',
    path: 'data/words/4-letters.txt',
    cadence: 'three-hourly',
    names: 1,
  }

  it('keeps a carried instant that is older than the scan time', () => {
    const document = withSources([
      {
        id: 'five-letters',
        path: 'data/words/5-letters.txt',
        cadence: 'daily',
        names: 1,
        lastScannedAt: CARRIED,
      },
      SCANNED,
    ])

    expect(parseSnapshotDocument(document).metadata.sources.map((s) => s.last_scanned_at)).toEqual([
      '2026-02-28T16:00:00Z',
      '2026-03-01T12:00:00Z',
    ])
  })

  it('exposes each instant as a Date on the view model', () => {
    const document = withSources([
      {
        id: 'five-letters',
        path: 'data/words/5-letters.txt',
        cadence: 'daily',
        names: 1,
        lastScannedAt: CARRIED,
      },
      SCANNED,
    ])

    const snapshot = toSnapshot(parseSnapshotDocument(document))
    expect(snapshot.metadata.sources.map((source) => source.lastScannedAt.getTime())).toEqual([
      CARRIED.getTime(),
      SCANNED_AT.getTime(),
    ])
  })

  it('refuses a missing instant rather than falling back to the scan time', () => {
    const document = withSources([
      { id: 'five-letters', path: 'data/words/5-letters.txt', cadence: 'daily', names: 1 },
      SCANNED,
    ])
    const sources = document.metadata.sources.map((source, index) =>
      index === 0 ? { ...source, last_scanned_at: undefined } : source,
    )
    const broken = { ...document, metadata: { ...document.metadata, sources } }

    expect(() => parseSnapshotDocument(broken)).toThrow(/last_scanned_at/)
  })

  it('refuses an instant that is not a canonical UTC second', () => {
    const document = withSources([
      { id: 'five-letters', path: 'data/words/5-letters.txt', cadence: 'daily', names: 1 },
      SCANNED,
    ])
    const sources = document.metadata.sources.map((source, index) =>
      index === 0 ? { ...source, last_scanned_at: '2026-02-28T16:00:00.500Z' } : source,
    )
    const broken = { ...document, metadata: { ...document.metadata, sources } }

    expect(() => parseSnapshotDocument(broken)).toThrow(/last_scanned_at/)
  })

  it('refuses a list scanned after the snapshot itself was', () => {
    const document = withSources([
      {
        id: 'five-letters',
        path: 'data/words/5-letters.txt',
        cadence: 'daily',
        names: 1,
        lastScannedAt: new Date(SCANNED_AT.getTime() + 1000),
      },
      SCANNED,
    ])

    expect(() => parseSnapshotDocument(document)).toThrow(/after the snapshot scan time/)
  })

  it('refuses a snapshot no list was scanned at', () => {
    const document = withSources([
      {
        id: 'five-letters',
        path: 'data/words/5-letters.txt',
        cadence: 'daily',
        names: 1,
        lastScannedAt: CARRIED,
      },
      { ...SCANNED, lastScannedAt: CARRIED },
    ])

    expect(() => parseSnapshotDocument(document)).toThrow(/no list that was scanned/)
  })
})

describe('assertPointerMatches source scan times', () => {
  it('refuses a pointer whose list instants disagree with the body', () => {
    const document = buildSnapshotDocument()
    const pointer = buildLatestDocument(document)
    const sources = pointer.sources.map((source, index) =>
      index === 0 ? { ...source, last_scanned_at: '2026-02-28T16:00:00Z' } : source,
    )

    const body = parseSnapshotDocument(document)
    const latest = parseLatestDocument({ ...pointer, sources })
    expect(() => {
      assertPointerMatches(body, latest)
    }).toThrow(/source lists disagree/)
  })

  it('accepts the pointer the publisher writes beside the body', () => {
    const document = buildSnapshotDocument()
    const body = parseSnapshotDocument(document)
    const latest = parseLatestDocument(buildLatestDocument(document))
    expect(() => {
      assertPointerMatches(body, latest)
    }).not.toThrow()
  })
})
