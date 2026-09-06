import type { ReactNode } from 'react'
import { formatAbsolute, formatAgo, toIsoSecond } from '../format/time'
import { resolveSnapshotAge, resolveSourceGroups } from '../snapshot/staleness'
import type { Snapshot } from '../snapshot/types'

/**
 * One line saying where this data came from and how far it can be trusted.
 *
 * It exists because the full provenance now sits in a disclosure below the list,
 * and a reader must not have to open it to learn the two things that decide whether
 * the page in front of them means anything: when the scan was taken, and whether
 * every source list is inside its own schedule. Those are stated here, in words, on
 * the first screen.
 *
 * The counts are of lists, not of names, and they are resolved per list against
 * that list's own cadence - the same resolution the disclosure and the alert use,
 * from the same function, so the three can never disagree.
 *
 * It deliberately avoids the exact phrases the per-list tiles use. Those are
 * counted elsewhere as evidence of how many lists are in which state, and a
 * summary that repeated them verbatim would be indistinguishable from a fourth
 * list.
 *
 * The phrases are separated by space alone, with no interpunct between them. The line
 * is too long to hold below about 1100px, so it wraps, and any separator drawn as its
 * own element ends up the last glyph of a wrapped line pointing at nothing. Space
 * cannot be stranded.
 */
export interface TrustLineProps {
  readonly snapshot: Snapshot
  readonly now: Date
}

export function TrustLine({ snapshot, now }: TrustLineProps): ReactNode {
  const { metadata } = snapshot
  const age = resolveSnapshotAge(metadata, now)
  const groups = resolveSourceGroups(metadata, now)
  const stale = groups.filter((group) => group.scanAge.isStale).length
  const total = groups.length

  return (
    <p className="trustline">
      <span className={`badge badge--${stale === 0 ? 'good' : 'warn'} trustline__state`}>
        {stale === 0
          ? `All ${String(total)} ${total === 1 ? 'list' : 'lists'} inside schedule`
          : `${String(stale)} of ${String(total)} ${total === 1 ? 'list' : 'lists'} behind schedule`}
      </span>
      <span className="trustline__when">
        Scanned{' '}
        <time className="mono" dateTime={toIsoSecond(metadata.scannedAt)}>
          {formatAbsolute(metadata.scannedAt)}
        </time>
        {age.clockBehind ? '' : `, ${formatAgo(age.ageSeconds)}`}
      </span>
      {/*
        Three words shorter than it reads, on purpose. With `before registering` on the
        end, the line could not hold at 1440px and `Scan details` fell to a second line,
        which pushed the first name down a row for no new information: the disclosure
        below the list gives the full advice, price included.
      */}
      <span className="trustline__caveat">
        Recorded statuses, not a live check. Confirm with{' '}
        <a href="https://app.ens.domains/" rel="noopener noreferrer" target="_blank">
          ENS
        </a>
        .
      </span>
      <a className="trustline__more" href="#details">
        Scan details
      </a>
    </p>
  )
}
