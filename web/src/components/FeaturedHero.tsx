import type { MouseEvent, ReactNode } from 'react'
import { resolveSnapshotAge } from '../snapshot/staleness'
import type { Snapshot } from '../snapshot/types'
import type { FeaturedSelection } from '../ranking/contract'
import type { CheckFailure } from '../verify/failure'
import { FeaturedMapSkeleton, FeaturedNameMap } from './FeaturedNameMap'
import { VerifyFailureNotice } from './VerifyBar'
import type { VerifyBinding } from './verification'

export interface FeaturedHeroProps {
  readonly availableCount: number
  readonly checking: boolean
  readonly failure: CheckFailure | null
  readonly now: Date
  readonly onCheck: () => void
  readonly onDismissFailure: () => void
  readonly onExplore: (event: MouseEvent<HTMLAnchorElement>) => void
  readonly selection: FeaturedSelection | null
  readonly snapshot: Snapshot
  readonly verify: VerifyBinding | null
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

function countLabel(count: number): string {
  return count.toLocaleString('en-GB')
}

function checkLabel(count: number, checking: boolean): string {
  if (checking) {
    return `Checking ${String(count)} ${count === 1 ? 'name' : 'names'}`
  }
  if (count === 0) {
    return 'Select names to check'
  }
  return `Check ${String(count)} ${count === 1 ? 'name' : 'names'}`
}

export function FeaturedHero({
  availableCount,
  checking,
  failure,
  now,
  onCheck,
  onDismissFailure,
  onExplore,
  selection,
  snapshot,
  verify,
}: FeaturedHeroProps): ReactNode {
  const selectedCount = verify?.selected.size ?? 0
  const snapshotAge = resolveSnapshotAge(snapshot.metadata, now)
  const names = selection?.desktop ?? []

  return (
    <section
      aria-busy={selection === null ? 'true' : undefined}
      aria-labelledby="featured-title"
      className="featured-hero"
      data-featured-source={selection?.source ?? 'loading'}
    >
      <div className="page featured-hero__inner">
        <div className="featured-hero__meta">
          <span className="featured-hero__count">
            <span aria-hidden="true" className="featured-hero__dot">
              ●
            </span>
            {countLabel(availableCount)} available in the latest scan
          </span>
          <span>
            Snapshot {compactAge(snapshotAge.ageSeconds)} <span aria-hidden="true">·</span> not a
            live check
          </span>
        </div>

        <div className="featured-hero__copy">
          <h1 id="featured-title">The good ones are still out there.</h1>
          <p>Strong, memorable names from the latest snapshot.</p>
        </div>

        <div className="featured-hero__map">
          {selection === null ? (
            <FeaturedMapSkeleton />
          ) : (
            <FeaturedNameMap names={names} now={now} verify={verify} />
          )}
        </div>

        <div className="featured-hero__actions">
          <button
            className="featured-hero__check"
            disabled={verify === null || selectedCount === 0 || checking}
            onClick={onCheck}
            type="button"
          >
            {checkLabel(selectedCount, checking)}
          </button>
          <a className="featured-hero__explore" href="#page-title" onClick={onExplore}>
            Explore all {countLabel(availableCount)} <span aria-hidden="true">↓</span>
          </a>
        </div>

        <p className="featured-hero__trust" id="featured-trust">
          Snapshot availability only <span aria-hidden="true">·</span> fresh check required before
          an ENS link
        </p>

        {failure !== null && (
          <div className="featured-hero__failure">
            <VerifyFailureNotice failure={failure} onCheck={onCheck} onDismiss={onDismissFailure} />
          </div>
        )}
      </div>
    </section>
  )
}
