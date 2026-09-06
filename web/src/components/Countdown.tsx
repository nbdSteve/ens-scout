import type { ReactNode } from 'react'
import {
  formatAgo,
  formatCoarseDuration,
  formatPreciseDuration,
  secondsBetween,
  splitAbsolute,
  toIsoSecond,
} from '../format/time'
import type { Boundary, BoundaryKind } from '../snapshot/lifecycle'

/**
 * The time left until a timestamp the snapshot recorded.
 *
 * This is presentation of one published instant and nothing more. It subtracts the
 * visitor's clock from `boundary.at`, which came straight off the scan record, and
 * it never derives one boundary from another and never changes a status. A
 * countdown reaching zero means the recorded moment has passed on this device's
 * clock; it does not mean the name moved to the next stage, because only a later
 * scan can say that. The passed case says so in words rather than leaving the
 * visitor to infer it from a row of zeroes.
 *
 * The ticking value is hidden from assistive technology and paired with a coarse
 * static sentence. A value that changes every second would otherwise be announced
 * every second, and fifty of them on one page would make the table unusable.
 */
export interface CountdownProps {
  readonly boundary: Boundary
  readonly now: Date
}

/**
 * The same boundary in the past tense. `Boundary.label` is written for a boundary
 * still ahead, and "grace period ends 3 hours ago" is not a sentence.
 */
const PASSED_LABEL: Readonly<Record<BoundaryKind, string>> = {
  expiry: 'registration expired',
  'grace-end': 'grace period ended',
  'premium-end': 'premium ended',
}

export function Countdown({ boundary, now }: CountdownProps): ReactNode {
  const remaining = secondsBetween(now, boundary.at)
  const passed = remaining <= 0
  const what = passed ? PASSED_LABEL[boundary.kind] : boundary.label
  const { day, clock } = splitAbsolute(boundary.at)

  return (
    <div className="countdown">
      <p className="countdown__what">{what}</p>
      <p className="countdown__at">
        {/*
          Two spans rather than one string, so the only place the instant can break
          is between the date and the clock time. Either half is unbreakable, which
          is what keeps a phone-width cell to two lines instead of four.
        */}
        <time className="mono" dateTime={toIsoSecond(boundary.at)}>
          <span>{day}</span> <span>{clock}</span>
        </time>
      </p>
      <p className="countdown__left">
        {/*
          Hidden because it changes every second. The sentence beside it carries the
          same information at a granularity worth announcing.
        */}
        <span
          aria-hidden="true"
          className={`countdown__value mono${passed ? ' countdown__value--passed' : ''}`}
        >
          {formatPreciseDuration(Math.abs(remaining))}
        </span>
        <span className="visually-hidden">
          {passed
            ? `${what} ${formatAgo(-remaining)}`
            : `${what} in ${formatCoarseDuration(remaining)}`}
        </span>
      </p>
      {passed && (
        <p className="countdown__note">
          This moment has passed since the scan. The status is still the one the scan recorded, so
          confirm the name on the ENS app.
        </p>
      )}
    </div>
  )
}
