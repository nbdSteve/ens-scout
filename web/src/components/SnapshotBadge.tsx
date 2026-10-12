import type { ReactNode } from 'react'
import { resolveSnapshotAge, resolveSourceGroups } from '../snapshot/staleness'
import type { Snapshot } from '../snapshot/types'

export interface SnapshotBadgeProps {
  readonly now: Date
  readonly preview: boolean
  readonly snapshot: Snapshot
}

function compactAge(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  if (minutes < 60) {
    return `${String(Math.max(1, minutes))}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return `${String(hours)}h`
  }
  return `${String(Math.floor(hours / 24))}d`
}

function previewDay(now: Date): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(now)
}

export function SnapshotBadge({ now, preview, snapshot }: SnapshotBadgeProps): ReactNode {
  const age = resolveSnapshotAge(snapshot.metadata, now)
  const stale = resolveSourceGroups(snapshot.metadata, now).some((group) => group.scanAge.isStale)

  return (
    <div className="snapshot-strip">
      <span className={`snapshot-badge${stale ? ' snapshot-badge--stale' : ''}`}>
        <span aria-hidden="true" className="snapshot-badge__dot">
          {stale ? '▲' : '●'}
        </span>
        {preview ? (
          <>
            Preview <span aria-hidden="true">·</span> {previewDay(now)}
            {stale && <span className="snapshot-badge__warning"> Stale</span>}
          </>
        ) : stale ? (
          <>
            Stale <span aria-hidden="true">·</span> {compactAge(age.ageSeconds)}
          </>
        ) : (
          <>Snapshot {compactAge(age.ageSeconds)}</>
        )}
      </span>

      <a
        className="snapshot-strip__link"
        href="https://app.ens.domains/"
        rel="noopener noreferrer"
        target="_blank"
      >
        Verify on ENS <span aria-hidden="true">↗</span>
        <span className="visually-hidden">, opens in a new tab</span>
      </a>
    </div>
  )
}
