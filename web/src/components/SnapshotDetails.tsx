import type { ReactNode } from 'react'
import { SnapshotStatus } from './SnapshotStatus'
import { SummaryCounts } from './SummaryCounts'
import type { AppConfig } from '../config/env'
import { FIXTURE_DESCRIPTION } from '../data/fixtures'
import type { Snapshot } from '../snapshot/types'
import type { SnapshotOrigin } from '../state/useSnapshot'
import { VIEWS } from '../state/views'

/**
 * Everything a reader may want to check, in one disclosure below the results.
 *
 * The provenance, the per-list schedules, the published counts, the lifecycle rules,
 * and what this page is not are all necessary, and none of them is what a visitor
 * came for. Above the list they cost the whole first screen and pushed the names out
 * of sight; here they cost one line until asked for. What stays above the list is the
 * short form: the trust line always states the scan time and that these are recorded
 * statuses, and an overdue list still raises its own alert there.
 *
 * It is a native `<details>`, so it works with no JavaScript, is a single tab stop
 * when closed, and is announced as an expandable group. Its content is always in the
 * DOM, so a browser find-in-page reaches it and, when a link points at
 * `#details` inside it, the browser opens the disclosure on the way.
 */
export interface SnapshotDetailsProps {
  readonly snapshot: Snapshot
  readonly now: Date
  readonly origin: SnapshotOrigin
  readonly cachedAt: Date | null
  readonly confirmedCurrent: boolean
  readonly config: AppConfig
}

export function SnapshotDetails({
  snapshot,
  now,
  origin,
  cachedAt,
  confirmedCurrent,
  config,
}: SnapshotDetailsProps): ReactNode {
  return (
    <details className="disclosure">
      <summary className="disclosure__summary">
        <span className="disclosure__label">Scan details, source lists, and method</span>
        <span className="disclosure__hint">
          Where this came from, how each list is scheduled, what the statuses mean, and what this
          page is not
        </span>
      </summary>

      {/*
        The anchor sits inside the disclosure rather than on it, because a fragment
        that lands on a closed `<details>` scrolls to a collapsed strip, while one
        that lands inside it makes the browser open the disclosure first.
      */}
      <div className="disclosure__body" id="details">
        <SnapshotStatus
          cachedAt={cachedAt}
          confirmedCurrent={confirmedCurrent}
          now={now}
          origin={origin}
          snapshot={snapshot}
        />

        <SummaryCounts metadata={snapshot.metadata} />

        <section aria-labelledby="lifecycle-heading" className="card">
          <div>
            <h3 className="card__title" id="lifecycle-heading">
              What each status means
            </h3>
            <p className="prose">
              An ENSv1 <code>.eth</code> registration moves through fixed stages, and the scanner
              works out every boundary from the expiry the subgraph recorded. This page only
              displays what the scan published; it never computes a status of its own.
            </p>
          </div>

          <dl className="facts">
            <div className="fact">
              <dt className="fact__label">Registered</dt>
              <dd className="fact__value">
                Held by an owner until the recorded expiry. <em>Expiring soon</em> is the same
                state, close enough to expiry to be worth watching.
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">Grace period</dt>
              <dd className="fact__value">
                Exactly 90 days after expiry. The name is expired, but only the previous owner may
                renew it. <em>Grace ending soon</em> is the last part of that window.
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">Premium</dt>
              <dd className="fact__value">
                The 21 days after the grace period. Anyone may register the name, at a temporary
                premium that declines to nothing over that window.
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">Available</dt>
              <dd className="fact__value">
                Past the premium window, so it was open at standard pricing at the scan time.
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">Unknown</dt>
              <dd className="fact__value">
                Registered, with an expiry the index did not give or could not be read. Reported as
                unknown rather than guessed at, and never reported as available.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="method-heading" className="card">
          <div>
            <h3 className="card__title" id="method-heading">
              What this page is, and what it is not
            </h3>
          </div>

          <div className="prose-stack">
            <p className="prose">
              <strong>ENS decides, not this page.</strong> The subgraph is an index, not the
              registration authority, and a name shown as available was available at the scan time
              above - which is not the same as available now. Confirm availability and price with{' '}
              <a href="https://app.ens.domains/" rel="noopener noreferrer" target="_blank">
                the ENS app
              </a>{' '}
              before registering anything.
            </p>
            <p className="prose">
              Nothing on this page is re-checked in your browser. The countdowns move because your
              clock does, and one reaching zero means the recorded moment has passed on this device
              - not that the name moved on. Only a later scan can say that, so a passed boundary
              says so in words instead of showing zeroes.
            </p>
            <p className="prose">
              Each source list is scanned on its own schedule and is called out above once it has
              missed more than one scheduled scan. The thresholds are published with the snapshot;
              your browser resolves them against your own clock rather than trusting a flag someone
              else set.
            </p>
            {config.apiBaseUrl === null && (
              <p className="prose">
                No read API is configured for this build, so the page is showing the committed{' '}
                <code>{config.fixtureId}</code> fixture: {FIXTURE_DESCRIPTION[config.fixtureId]}
              </p>
            )}
          </div>

          <div>
            <h4 className="fact__label" id="views-heading">
              What each view holds
            </h4>
            <dl aria-labelledby="views-heading" className="facts">
              {VIEWS.map((view) => (
                <div className="fact" key={view.id}>
                  <dt className="fact__label">{view.label}</dt>
                  <dd className="fact__value">{view.summary}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </div>
    </details>
  )
}
