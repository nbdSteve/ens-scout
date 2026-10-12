import type { MouseEvent, ReactNode } from 'react'
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
  readonly verify: VerifyBinding | null
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
  verify,
}: FeaturedHeroProps): ReactNode {
  const selectedCount = verify?.selected.size ?? 0
  const names = selection?.desktop ?? []

  return (
    <section
      aria-busy={selection === null ? 'true' : undefined}
      aria-labelledby="featured-title"
      className="featured-hero"
      data-featured-source={selection?.source ?? 'loading'}
    >
      <div className="page featured-hero__inner">
        <h1 className="visually-hidden" id="featured-title">
          Featured available .eth names
        </h1>

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
            Explore all {countLabel(availableCount)}
            <span aria-hidden="true" className="featured-hero__explore-arrow">
              ↓
            </span>
          </a>
        </div>

        {failure !== null && (
          <div className="featured-hero__failure">
            <VerifyFailureNotice failure={failure} onCheck={onCheck} onDismiss={onDismissFailure} />
          </div>
        )}
      </div>
    </section>
  )
}
