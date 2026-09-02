import { FORMAT_VERSION, STATUSES, deriveScanAgeSeconds } from '../snapshot/contract'
import { codePointLength } from '../format/text'
import type { Cadence, Status } from '../snapshot/contract'
import { parseSnapshotDocument, snapshotCadences, toSnapshot } from '../snapshot/parse'
import type {
  MetadataDocument,
  ResultDocument,
  Snapshot,
  SnapshotDocument,
} from '../snapshot/types'

/**
 * A dense snapshot for the visual prototype, built in the browser.
 *
 * The committed `preview` fixture carries one name per status, so it holds two
 * available names and cannot show what browsing a real scan feels like. This
 * dataset exists to fill the screen instead, and it is frontend-only on purpose:
 * `data/fixtures/` is the shared contract's own output and nothing here may move
 * its bytes.
 *
 * Every status and every boundary below is a literal, and the document is handed
 * to the real parser before anything renders. So this is not a second source of
 * truth about the ENS lifecycle: it is a payload the shipped validator accepts,
 * and if a hand-written instant ever contradicted the contract the prototype
 * would fail to load rather than draw something the scanner could not publish.
 *
 * The counts, the name total, the per-list totals and the staleness thresholds are
 * derived from the rows here, because the parser cross-checks all four and a
 * hand-maintained tally would drift the first time a name was added.
 */

interface Row {
  readonly label: string
  readonly status: Status
  readonly expiry?: string
  readonly graceEnds?: string
  readonly premiumEnds?: string
}

/** The scan this dataset describes. Fixed, so the prototype is reproducible. */
export const PROTOTYPE_SCANNED_AT = '2026-03-01T12:00:00Z'

/*
 * Label lengths 3, 4 and 5, which is what the three source lists below cover.
 * Available names carry no boundary at all: an available name is past every one
 * of them, and inventing an expiry to fill the column would be a fiction.
 */
const ROWS: readonly Row[] = [
  { label: 'arc', status: 'available' },
  { label: 'bit', status: 'available' },
  { label: 'dot', status: 'available' },
  { label: 'hex', status: 'available' },
  { label: 'ion', status: 'available' },
  { label: 'orb', status: 'available' },
  { label: 'pod', status: 'available' },
  { label: 'vex', status: 'available' },
  {
    label: 'kin',
    status: 'premium',
    expiry: '2025-11-20T05:00:00Z',
    graceEnds: '2026-02-18T05:00:00Z',
    premiumEnds: '2026-03-11T05:00:00Z',
  },
  { label: 'rex', status: 'registered', expiry: '2027-08-14T09:30:00Z' },
  { label: 'zen', status: 'registered', expiry: '2028-01-02T18:00:00Z' },
  { label: 'zip', status: 'expiring-soon', expiry: '2026-03-19T07:15:00Z' },

  { label: 'bolt', status: 'available' },
  { label: 'cove', status: 'available' },
  { label: 'dune', status: 'available' },
  { label: 'echo', status: 'available' },
  { label: 'gale', status: 'available' },
  { label: 'helm', status: 'available' },
  { label: 'iris', status: 'available' },
  { label: 'jade', status: 'available' },
  { label: 'onyx', status: 'available' },
  {
    label: 'flux',
    status: 'grace-ending-soon',
    expiry: '2025-12-06T11:00:00Z',
    graceEnds: '2026-03-06T11:00:00Z',
    premiumEnds: '2026-03-27T11:00:00Z',
  },
  {
    label: 'kilo',
    status: 'grace-period',
    expiry: '2026-01-14T22:45:00Z',
    graceEnds: '2026-04-14T22:45:00Z',
    premiumEnds: '2026-05-05T22:45:00Z',
  },
  {
    label: 'lyra',
    status: 'premium',
    expiry: '2025-11-27T14:20:00Z',
    graceEnds: '2026-02-25T14:20:00Z',
    premiumEnds: '2026-03-18T14:20:00Z',
  },
  { label: 'mint', status: 'registered', expiry: '2029-04-30T00:00:00Z' },
  { label: 'nova', status: 'expiring-soon', expiry: '2026-03-24T16:05:00Z' },

  { label: 'amber', status: 'available' },
  { label: 'cedar', status: 'available' },
  { label: 'ember', status: 'available' },
  { label: 'flint', status: 'available' },
  { label: 'grove', status: 'available' },
  { label: 'haven', status: 'available' },
  { label: 'jetty', status: 'available' },
  { label: 'larch', status: 'available' },
  { label: 'north', status: 'available' },
  {
    label: 'delta',
    status: 'premium',
    expiry: '2025-11-14T08:00:00Z',
    graceEnds: '2026-02-12T08:00:00Z',
    premiumEnds: '2026-03-05T08:00:00Z',
  },
  {
    label: 'ivory',
    status: 'grace-period',
    expiry: '2026-02-02T03:10:00Z',
    graceEnds: '2026-05-03T03:10:00Z',
    premiumEnds: '2026-05-24T03:10:00Z',
  },
  { label: 'maple', status: 'registered', expiry: '2027-12-11T13:00:00Z' },
  { label: 'orbit', status: 'unknown' },
]

/** One list per label length, matching how `data/words/` is organized. */
const LISTS: readonly { readonly length: number; readonly source: SourceSpec }[] = [
  {
    length: 3,
    source: { id: 'three-letters', path: 'data/words/3-letters.txt', cadence: 'three-hourly' },
  },
  {
    length: 4,
    source: { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'three-hourly' },
  },
  { length: 5, source: { id: 'five-letters', path: 'data/words/5-letters.txt', cadence: 'daily' } },
]

interface SourceSpec {
  readonly id: string
  readonly path: string
  readonly cadence: Cadence
}

function toResultDocument(row: Row): ResultDocument {
  return {
    name: `${row.label}.eth`,
    status: row.status,
    ...(row.expiry === undefined ? {} : { expiry: row.expiry }),
    ...(row.graceEnds === undefined ? {} : { grace_ends: row.graceEnds }),
    ...(row.premiumEnds === undefined ? {} : { premium_ends: row.premiumEnds }),
  }
}

function buildDocument(): SnapshotDocument {
  const results: readonly ResultDocument[] = [...ROWS]
    .map(toResultDocument)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  const counts = {} as Record<Status, number>
  for (const status of STATUSES) {
    counts[status] = 0
  }
  for (const row of ROWS) {
    counts[row.status] += 1
  }

  const sources = LISTS.map((list) => ({
    ...list.source,
    names: ROWS.filter((row) => codePointLength(row.label) === list.length).length,
  })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const scanAge = deriveScanAgeSeconds(snapshotCadences(sources))
  if (scanAge === null) {
    throw new Error('the prototype dataset declares no source list')
  }

  const metadata: MetadataDocument = {
    format_version: FORMAT_VERSION,
    snapshot_id: 'prototype-20260301t120000z',
    scanned_at: PROTOTYPE_SCANNED_AT,
    sources,
    scan_age: {
      expected_interval_seconds: scanAge.expectedIntervalSeconds,
      stale_after_seconds: scanAge.staleAfterSeconds,
    },
    names: results.length,
    counts,
  }

  return { metadata, results }
}

/** The dataset, validated by the shipped parser exactly as a published one is. */
export function prototypeSnapshot(): Snapshot {
  return toSnapshot(parseSnapshotDocument(buildDocument()))
}
