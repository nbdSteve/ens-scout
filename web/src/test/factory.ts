import { FORMAT_VERSION, STATUSES, type Cadence, type Status } from '../snapshot/contract'
import { toIsoSecond } from '../format/time'
import { parseLatestDocument, parseSnapshotDocument, toSnapshot } from '../snapshot/parse'
import type {
  LatestDocument,
  MetadataDocument,
  ResultDocument,
  Snapshot,
  SnapshotDocument,
} from '../snapshot/types'

/**
 * Snapshot documents for tests.
 *
 * These are built here rather than read from `data/fixtures/`, so a test can put a
 * scan at whatever instant it needs and can produce payloads the Go side would
 * never publish - a missing field, an unknown status, a pointer that names a
 * different scan. The committed fixtures cover the opposite case, that real
 * published bytes render, and the browser tests use those.
 */

/** A fixed scan time. Tests that measure an age offset from this. */
export const SCANNED_AT = new Date('2026-03-01T12:00:00Z')

export interface ResultSpec {
  readonly name: string
  readonly status: Status
  readonly expiry?: Date
  readonly graceEnds?: Date
  readonly premiumEnds?: Date
}

export interface SnapshotSpec {
  readonly snapshotId?: string
  readonly scannedAt?: Date
  readonly results?: readonly ResultSpec[]
  readonly sources?: readonly { id: string; path: string; cadence: Cadence; names: number }[]
  /** Overrides the counts derived from `results`, for a deliberately wrong payload. */
  readonly counts?: Readonly<Record<Status, number>>
  readonly expectedIntervalSeconds?: number
  readonly staleAfterSeconds?: number
}

function zeroCounts(): Record<Status, number> {
  const counts = {} as Record<Status, number>
  for (const status of STATUSES) {
    counts[status] = 0
  }
  return counts
}

function toResultDocument(spec: ResultSpec): ResultDocument {
  return {
    name: spec.name,
    status: spec.status,
    ...(spec.expiry === undefined ? {} : { expiry: toIsoSecond(spec.expiry) }),
    ...(spec.graceEnds === undefined ? {} : { grace_ends: toIsoSecond(spec.graceEnds) }),
    ...(spec.premiumEnds === undefined ? {} : { premium_ends: toIsoSecond(spec.premiumEnds) }),
  }
}

const DEFAULT_RESULTS: readonly ResultSpec[] = [
  {
    name: 'aaaa.eth',
    status: 'available',
  },
  {
    name: 'bbbb.eth',
    status: 'premium',
    expiry: new Date('2025-11-01T00:00:00Z'),
    graceEnds: new Date('2026-01-30T00:00:00Z'),
    premiumEnds: new Date('2026-03-05T00:00:00Z'),
  },
  {
    name: 'cccc.eth',
    status: 'expiring-soon',
    expiry: new Date('2026-03-20T00:00:00Z'),
  },
  {
    name: 'ddddd.eth',
    status: 'grace-period',
    expiry: new Date('2026-02-20T00:00:00Z'),
    graceEnds: new Date('2026-05-21T00:00:00Z'),
  },
]

// Sorted by id, which is what the publisher writes and what the parser requires.
const DEFAULT_SOURCES: readonly { id: string; path: string; cadence: Cadence; names: number }[] = [
  { id: 'five-letters', path: 'data/words/5-letters.txt', cadence: 'daily', names: 1 },
  { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'three-hourly', names: 3 },
]

export function buildSnapshotDocument(spec: SnapshotSpec = {}): SnapshotDocument {
  const results = (spec.results ?? DEFAULT_RESULTS).map(toResultDocument)
  const counts = zeroCounts()
  if (spec.counts === undefined) {
    for (const result of results) {
      counts[result.status] += 1
    }
  } else {
    for (const status of STATUSES) {
      counts[status] = spec.counts[status]
    }
  }
  const metadata: MetadataDocument = {
    format_version: FORMAT_VERSION,
    snapshot_id: spec.snapshotId ?? 'test-snapshot',
    scanned_at: toIsoSecond(spec.scannedAt ?? SCANNED_AT),
    sources: spec.sources ?? DEFAULT_SOURCES,
    scan_age: {
      expected_interval_seconds: spec.expectedIntervalSeconds ?? 24 * 60 * 60,
      stale_after_seconds: spec.staleAfterSeconds ?? 48 * 60 * 60,
    },
    names: results.length,
    counts,
  }
  return { metadata, results }
}

/**
 * The same scan as the view model components take.
 *
 * It goes through the real parser rather than building the view model directly, so
 * a factory change that the publisher would never make - an out-of-order source
 * list, an unusable snapshot id - fails here instead of producing a payload no
 * real reader would accept.
 */
export function buildSnapshot(spec: SnapshotSpec = {}): Snapshot {
  const document = buildSnapshotDocument(spec)
  return toSnapshot(
    parseSnapshotDocument(document),
    parseLatestDocument(buildLatestDocument(document)),
  )
}

export function buildLatestDocument(document: SnapshotDocument): LatestDocument {
  return {
    format_version: FORMAT_VERSION,
    snapshot_id: document.metadata.snapshot_id,
    scanned_at: document.metadata.scanned_at,
    published_at: document.metadata.scanned_at,
    checksum: 'a'.repeat(64),
    compressed_checksum: 'b'.repeat(64),
    raw_bytes: 1024,
    compressed_bytes: 512,
    chunk_count: 1,
    names: document.metadata.names,
    counts: document.metadata.counts,
    sources: document.metadata.sources,
    scan_age: document.metadata.scan_age,
  }
}
