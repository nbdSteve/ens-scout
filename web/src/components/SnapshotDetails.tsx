import type { ReactNode } from 'react'
import { SnapshotStatus } from './SnapshotStatus'
import { SummaryCounts } from './SummaryCounts'
import type { AppConfig } from '../config/env'
import { FIXTURE_DESCRIPTION } from '../data/fixtures'
import type { Snapshot } from '../snapshot/types'
import type { SnapshotOrigin } from '../state/useSnapshot'
import { VIEWS } from '../state/views'

/**
 * The complete snapshot context rendered inside the Data drawer.
 *
 * Provenance, source schedules, published counts, lifecycle rules, and caveats all
 * remain available without competing with the names in the discovery path. The
 * drawer owns disclosure, focus management, and dismissal; this component only
 * supplies the structured content.
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
    <div className="data-details" id="details">
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
            works out every boundary from the expiry the subgraph recorded. This page only displays
            what the scan published; it never computes a status of its own.
          </p>
        </div>

        <dl className="facts">
          <div className="fact">
            <dt className="fact__label">Registered</dt>
            <dd className="fact__value">
              Held by an owner until the recorded expiry. <em>Expiring soon</em> is the same state,
              close enough to expiry to be worth watching.
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
          {/*
              What re-reads the index, and what does not. The sentence used to say that
              nothing on this page is re-checked, which a build with a verifier makes false:
              a fresh check is exactly that. Both halves are stated either way, because the
              countdowns are the scan's in both builds and a visitor reading a moving figure
              has no way to tell which of the two produced it.
            */}
          {config.apiBaseUrl === null ? (
            <p className="prose">
              Nothing on this page is re-checked in your browser. Time passing on this device does
              not move a name into another status; only a later scan can say that.
            </p>
          ) : (
            <>
              <p className="prose">
                A fresh check is the one thing here that reads the ENS index again. Select names in
                the list and ask for one: the answer is labelled with the instant it was read, it is
                shown beside the scan&rsquo;s answer rather than replacing it, and it lasts a short
                while. A name links out to the ENS app only while a fresh check covers it, and a
                check reserves nothing.
              </p>
              <p className="prose">
                Everything else on this page is the scan. Time passing on this device does not move
                a name into another status; only a later scan or a fresh check can provide a newer
                answer.
              </p>
            </>
          )}
          <p className="prose">
            Each source list is scanned on its own schedule and is called out above once it has
            missed more than one scheduled scan. The thresholds are published with the snapshot;
            your browser resolves them against your own clock rather than trusting a flag someone
            else set.
          </p>
          {config.apiBaseUrl === null && (
            <p className="prose">
              No read API is configured for this build, so the page is showing the committed{' '}
              <code>{config.fixtureId}</code> fixture: {FIXTURE_DESCRIPTION[config.fixtureId]} There
              is no verifier either, so nothing here can be re-checked and no name offers a link to
              a registration page.
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
  )
}
