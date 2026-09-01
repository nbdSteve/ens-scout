import type { ReactNode } from 'react'
import { formatCoarseDuration } from '../format/time'
import { resolveSourceGroups, type SourceGroup } from '../snapshot/staleness'
import type { SnapshotMetadata } from '../snapshot/types'
import { Notice } from './Notice'

/**
 * The warning that this snapshot is older than its own schedule promised.
 *
 * It is resolved per source list, against each list's own cadence, so a
 * three-hourly list that has missed two scans is called out even while a daily
 * list in the same snapshot is still inside its window. Folding the two together
 * would hide exactly the group a visitor should not act on.
 *
 * Everything here is deliberately coarse - `3 days`, not a ticking counter -
 * because this is a live region. A per-second value would re-announce itself to a
 * screen reader every second, which turns a warning into noise.
 *
 * Nothing is rendered when nothing is overdue. A dismissible or always-present
 * banner would train visitors to ignore the one case it exists for.
 */
export interface StaleWarningProps {
  readonly metadata: SnapshotMetadata
  readonly now: Date
}

export function StaleWarning({ metadata, now }: StaleWarningProps): ReactNode {
  const stale: readonly SourceGroup[] = resolveSourceGroups(metadata, now).filter(
    (group) => group.scanAge.isStale,
  )
  if (stale.length === 0) {
    return null
  }

  return (
    <Notice
      alert
      tone="warn"
      title={
        stale.length === 1
          ? 'One source list is out of date'
          : `${String(stale.length)} source lists are out of date`
      }
    >
      <p>
        These lists have missed more than one scheduled scan, so a name shown here may have changed
        state since. Treat every status below as history, and confirm with ENS before acting on it.
      </p>
      <ul className="notice__list">
        {stale.map((group) => (
          <li key={group.source.id}>
            <strong>{group.source.path}</strong> is scanned {group.cadenceLabel} and is overdue by{' '}
            {formatCoarseDuration(group.scanAge.overdueSeconds)}.
          </li>
        ))}
      </ul>
    </Notice>
  )
}
