import type { Status } from './contract'
import type { SnapshotResult } from './types'

/**
 * Presentation of a lifecycle status that `ens.Classify` already decided.
 *
 * Nothing here classifies. There is no grace-period arithmetic, no premium
 * arithmetic, and no rule that turns an expiry into an availability: the Go
 * scanner applied those at the scan instant the snapshot records, and this file
 * only chooses the words and the one timestamp worth counting down to.
 *
 * That boundary matters because the two would disagree. A browser recomputing a
 * grace end from an expiry would silently promote a name to `available` the
 * moment the visitor's clock crossed a threshold, while the published snapshot
 * still said `grace-period`, and the visitor would have no way to tell which
 * answer came from the scan.
 */

/** Short label for a status, as shown in a pill and in the filter controls. */
export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  registered: 'Registered',
  'expiring-soon': 'Expiring soon',
  'grace-period': 'Grace period',
  'grace-ending-soon': 'Grace ending soon',
  premium: 'Premium',
  available: 'Available',
  unknown: 'Unknown',
}

/** What the status meant at the scan instant. Plain language, no arithmetic. */
export const STATUS_DESCRIPTION: Readonly<Record<Status, string>> = {
  registered: 'Registered and not close to expiry at the scan time.',
  'expiring-soon': 'Registered, but the registration expires shortly after the scan time.',
  'grace-period': 'Expired and in the owner-only grace period, so it cannot be registered yet.',
  'grace-ending-soon': 'In the grace period, which ends shortly after the scan time.',
  premium: 'Released and open to anyone, with a temporary premium still added to the price.',
  available: 'Released with no temporary premium at the scan time.',
  unknown: 'The subgraph had no usable expiry for this name, so its state could not be decided.',
}

/**
 * How urgent a status is, used only for colour and ordering of the summary. It
 * is a display weight, not a lifecycle fact.
 */
export const STATUS_TONE: Readonly<Record<Status, 'good' | 'warn' | 'busy' | 'muted'>> = {
  registered: 'busy',
  'expiring-soon': 'warn',
  'grace-period': 'busy',
  'grace-ending-soon': 'warn',
  premium: 'warn',
  available: 'good',
  unknown: 'muted',
}

export type BoundaryKind = 'expiry' | 'grace-end' | 'premium-end'

export interface Boundary {
  readonly kind: BoundaryKind
  readonly at: Date
  /** What the boundary is, for a screen reader and for the column heading. */
  readonly label: string
}

const BOUNDARY_LABEL: Readonly<Record<BoundaryKind, string>> = {
  expiry: 'registration expires',
  'grace-end': 'grace period ends',
  'premium-end': 'premium ends',
}

/**
 * The next timestamp the snapshot itself recorded for this name, or null when it
 * recorded none.
 *
 * The choice is driven by the published status, and every candidate is read
 * straight off the record: `expiry`, `grace_ends`, and `premium_ends` were all
 * written by `ens.Classify`. A status with no matching timestamp - `available`,
 * `unknown` - has no boundary, and this returns null rather than inventing one.
 */
export function nextBoundary(result: SnapshotResult): Boundary | null {
  const pick = (kind: BoundaryKind, at: Date | null): Boundary | null =>
    at === null ? null : { kind, at, label: BOUNDARY_LABEL[kind] }

  switch (result.status) {
    case 'registered':
    case 'expiring-soon':
      return pick('expiry', result.expiry)
    case 'grace-period':
    case 'grace-ending-soon':
      return pick('grace-end', result.graceEnds)
    case 'premium':
      return pick('premium-end', result.premiumEnds)
    case 'available':
    case 'unknown':
      return null
  }
}

/** The ENS app page for one name. The only place a visitor should act on this data. */
export function ensAppUrl(name: string): string {
  return `https://app.ens.domains/${encodeURIComponent(name)}`
}
