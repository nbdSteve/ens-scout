import { CADENCE_INTERVAL_SECONDS, CADENCE_LABEL, STALE_FACTOR, type Cadence } from './contract'
import type { SnapshotMetadata, SourceList } from './types'
import { secondsBetween } from '../format/time'

/**
 * Staleness resolution.
 *
 * A snapshot never says whether it is stale. It publishes the schedule it was
 * meant to keep - the expected interval and the age at which a reader should
 * stop trusting it - and the reader resolves that against its own clock. A
 * published boolean would freeze at the moment of publication and go on
 * claiming freshness for as long as the file survived.
 */
export interface ScanAge {
  /** Whole seconds since the scan, clamped at zero. */
  readonly ageSeconds: number
  readonly expectedIntervalSeconds: number
  readonly staleAfterSeconds: number
  readonly isStale: boolean
  /** Seconds past the stale threshold, zero while fresh. */
  readonly overdueSeconds: number
  /** True when the reader's clock is behind the publisher's scan time. */
  readonly clockBehind: boolean
}

/**
 * Resolves an age against a threshold pair.
 *
 * A negative age means the reader's clock is behind the publisher's, which is
 * the visitor's clock being wrong rather than the data being from the future.
 * `snapshot.ScanAgeInput.At` clamps that to zero and so does this, but the fact
 * is kept so the interface can say why the age reads as zero.
 */
export function resolveScanAge(
  scannedAt: Date,
  now: Date,
  expectedIntervalSeconds: number,
  staleAfterSeconds: number,
): ScanAge {
  const elapsed = secondsBetween(scannedAt, now)
  const ageSeconds = Math.max(0, elapsed)
  const isStale = ageSeconds > staleAfterSeconds
  return {
    ageSeconds,
    expectedIntervalSeconds,
    staleAfterSeconds,
    isStale,
    overdueSeconds: isStale ? ageSeconds - staleAfterSeconds : 0,
    clockBehind: elapsed < 0,
  }
}

/** Thresholds for one cadence on its own, rather than for the whole snapshot. */
export function cadenceScanAge(cadence: Cadence, scannedAt: Date, now: Date): ScanAge {
  const expected = CADENCE_INTERVAL_SECONDS[cadence]
  return resolveScanAge(scannedAt, now, expected, expected * STALE_FACTOR)
}

/** One source list with its own schedule resolved. */
export interface SourceGroup {
  readonly source: SourceList
  readonly cadenceLabel: string
  readonly scanAge: ScanAge
}

/**
 * Resolves every source list against its own cadence and its own scan instant.
 *
 * The aggregate `scan_age` on the wire is derived from the slowest cadence,
 * because a snapshot as a whole is only as fresh as its least frequently scanned
 * list. That is the right rule for one headline number and the wrong rule for a
 * per-group warning: a three-hourly list is overdue long before a daily one, and
 * folding them together would hide exactly the group a visitor should not trust.
 * So each group is resolved against its own interval here.
 *
 * The instant is the list's own `lastScannedAt`, not the snapshot-wide scan time.
 * A publisher scans one group and carries the other group's results forward at the
 * fresh scan's instant, so measuring every list against the snapshot-wide time
 * made a list whose own schedule had stopped report the freshness of whichever
 * group was still publishing - which is the one case these warnings exist for.
 */
export function resolveSourceGroups(metadata: SnapshotMetadata, now: Date): SourceGroup[] {
  return metadata.sources.map((source) => ({
    source,
    cadenceLabel: CADENCE_LABEL[source.cadence],
    scanAge: cadenceScanAge(source.cadence, source.lastScannedAt, now),
  }))
}

/** The whole snapshot, against the thresholds the publisher put on the wire. */
export function resolveSnapshotAge(metadata: SnapshotMetadata, now: Date): ScanAge {
  return resolveScanAge(
    metadata.scannedAt,
    now,
    metadata.expectedIntervalSeconds,
    metadata.staleAfterSeconds,
  )
}

/** True when any single group is overdue, even if the aggregate still reads fresh. */
export function hasStaleGroup(groups: readonly SourceGroup[]): boolean {
  return groups.some((group) => group.scanAge.isStale)
}
