import type { ReactNode } from 'react'
import { formatAbsolute, formatAgo, formatCoarseDuration, toIsoSecond } from '../format/time'
import type { Snapshot } from '../snapshot/types'
import { resolveSnapshotAge, resolveSourceGroups } from '../snapshot/staleness'
import type { SnapshotOrigin } from '../state/useSnapshot'

/**
 * When this data is from, and how far it can be trusted.
 *
 * The exact scan time is the important number and it is shown in full, in UTC,
 * unrounded: two people comparing notes have to be able to tell whether they are
 * looking at the same scan. The readable age next to it is a convenience, derived
 * from the visitor's own clock, and it is always accompanied by the instant it was
 * derived from so a wrong local clock cannot make the page lie without also
 * showing the evidence.
 *
 * Each source list is then shown against its own schedule, because a snapshot
 * carries lists on different cadences and a three-hourly list is overdue long
 * before a daily one.
 */
export interface SnapshotStatusProps {
  readonly snapshot: Snapshot
  readonly now: Date
  readonly origin: SnapshotOrigin
  /** When the shown copy was stored locally, for the offline case. */
  readonly cachedAt: Date | null
  readonly confirmedCurrent: boolean
}

const ORIGIN_LABEL: Readonly<Record<SnapshotOrigin, string>> = {
  fixture: 'Fixture built into this page',
  network: 'Read API',
  cache: 'Stored in this browser',
}

export function SnapshotStatus({
  snapshot,
  now,
  origin,
  cachedAt,
  confirmedCurrent,
}: SnapshotStatusProps): ReactNode {
  const { metadata } = snapshot
  const age = resolveSnapshotAge(metadata, now)
  const groups = resolveSourceGroups(metadata, now)

  return (
    <section className="card scan" aria-labelledby="scan-heading">
      <div>
        <h2 className="card__title" id="scan-heading">
          Scan
        </h2>
        <p className="prose">
          Every status and countdown on this page describes the instant below. Nothing here is
          re-checked in your browser.
        </p>
      </div>

      <dl className="facts">
        <div className="fact">
          <dt className="fact__label">Scanned at</dt>
          <dd className="fact__value">
            <time className="mono" dateTime={toIsoSecond(metadata.scannedAt)}>
              {formatAbsolute(metadata.scannedAt)}
            </time>
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Age</dt>
          <dd className="fact__value">
            {age.clockBehind ? (
              <>
                <span>0 seconds</span>
                <br />
                <span className="field__hint">
                  This device&rsquo;s clock is behind the scan time, so the age cannot be worked
                  out.
                </span>
              </>
            ) : (
              formatAgo(age.ageSeconds)
            )}
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Expected cadence</dt>
          <dd className="fact__value">
            every {formatCoarseDuration(age.expectedIntervalSeconds)}
            <span className="visually-hidden">
              , counted as out of date after {formatCoarseDuration(age.staleAfterSeconds)}
            </span>
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Source</dt>
          <dd className="fact__value">
            {ORIGIN_LABEL[origin]}
            {cachedAt !== null && (
              <>
                <br />
                <span className="field__hint">
                  Stored{' '}
                  <time dateTime={toIsoSecond(cachedAt)}>
                    {formatAgo(
                      Math.max(0, Math.floor((now.getTime() - cachedAt.getTime()) / 1000)),
                    )}
                  </time>
                </span>
              </>
            )}
            {confirmedCurrent && (
              <>
                <br />
                <span className="field__hint">Confirmed as the current snapshot.</span>
              </>
            )}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="fact__label" id="groups-heading">
          Source lists
        </h3>
        <ul className="groups" aria-labelledby="groups-heading">
          {groups.map((group) => (
            <li
              className={`group${group.scanAge.isStale ? ' group--stale' : ''}`}
              key={group.source.id}
            >
              <p className="group__name">
                <span>{group.source.path}</span>
                <span className={`badge badge--${group.scanAge.isStale ? 'warn' : 'good'}`}>
                  {group.scanAge.isStale ? 'Out of date' : 'On schedule'}
                </span>
              </p>
              <div className="group__meta">
                <span>
                  {group.source.names.toLocaleString('en-GB')}{' '}
                  {group.source.names === 1 ? 'name' : 'names'}, scanned {group.cadenceLabel}
                </span>
                <span>
                  {group.scanAge.isStale
                    ? `Overdue by ${formatCoarseDuration(group.scanAge.overdueSeconds)}.`
                    : `Next scan due within ${formatCoarseDuration(
                        Math.max(
                          0,
                          group.scanAge.expectedIntervalSeconds - group.scanAge.ageSeconds,
                        ),
                      )}.`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {snapshot.publishedAt !== null && (
        <p className="field__hint">
          Published{' '}
          <time className="mono" dateTime={toIsoSecond(snapshot.publishedAt)}>
            {formatAbsolute(snapshot.publishedAt)}
          </time>
          . Publication is when the scan was stored, which is not when it was taken.
        </p>
      )}
    </section>
  )
}
