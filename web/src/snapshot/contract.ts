/**
 * The browser's half of the snapshot contract.
 *
 * Go owns these definitions. `internal/ens` owns the lifecycle statuses and all
 * lifecycle arithmetic, and `internal/snapshot` owns the wire format, the scan
 * cadences, and the staleness factor. Nothing here recomputes a lifecycle
 * status, a grace end, or a premium end: a published snapshot already carries
 * every one of those, and the browser only ever reads them.
 *
 * What this file does restate is the small set of constants a reader cannot
 * derive from the payload it is handed - the format version it accepts, the
 * cadence-to-interval table, and the staleness factor - because per-group
 * staleness needs the interval of each cadence and the wire carries only the
 * slowest one. `contract.drift.test.ts` reads the Go sources and fails when any
 * value here stops matching, so the duplication cannot drift silently.
 */

/** Wire version this client accepts. Mirrors `snapshot.FormatVersion`. */
export const FORMAT_VERSION = 3

/** Parent zone every stored name carries. Mirrors `snapshot.NameSuffix`. */
export const NAME_SUFFIX = '.eth'

/**
 * How many scheduled intervals may elapse before a scan counts as stale.
 * Mirrors `snapshot.StaleFactor`: one missed scan is tolerated, two is not.
 */
export const STALE_FACTOR = 2

/** Lifecycle statuses, in `ens.Statuses` order. */
export const STATUSES = [
  'registered',
  'expiring-soon',
  'grace-period',
  'grace-ending-soon',
  'premium',
  'available',
  'unknown',
] as const

export type Status = (typeof STATUSES)[number]

const STATUS_SET: ReadonlySet<string> = new Set<string>(STATUSES)

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && STATUS_SET.has(value)
}

/** Scan cadences, in `snapshot.Cadences` order. */
export const CADENCES = ['three-hourly', 'daily'] as const

export type Cadence = (typeof CADENCES)[number]

/** Scheduled gap between scans, in seconds. Mirrors `Cadence.Interval`. */
export const CADENCE_INTERVAL_SECONDS: Readonly<Record<Cadence, number>> = {
  'three-hourly': 3 * 60 * 60,
  daily: 24 * 60 * 60,
}

const CADENCE_SET: ReadonlySet<string> = new Set<string>(CADENCES)

export function isCadence(value: unknown): value is Cadence {
  return typeof value === 'string' && CADENCE_SET.has(value)
}

/** Human label for a cadence, used wherever an expected schedule is shown. */
export const CADENCE_LABEL: Readonly<Record<Cadence, string>> = {
  'three-hourly': 'every 3 hours',
  daily: 'every 24 hours',
}

/**
 * Staleness thresholds for a set of cadences. Mirrors
 * `snapshot.DeriveScanAgeInput`: the slowest cadence governs, because a snapshot
 * is only as fresh as its least frequently scanned list.
 *
 * Returns null for an empty set, which the wire format never allows.
 */
export function deriveScanAgeSeconds(
  cadences: readonly Cadence[],
): { expectedIntervalSeconds: number; staleAfterSeconds: number } | null {
  let slowest = 0
  for (const cadence of cadences) {
    const interval = CADENCE_INTERVAL_SECONDS[cadence]
    if (interval > slowest) {
      slowest = interval
    }
  }
  if (slowest === 0) {
    return null
  }
  return {
    expectedIntervalSeconds: slowest,
    staleAfterSeconds: slowest * STALE_FACTOR,
  }
}
