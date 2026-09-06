import type { ReactNode } from 'react'
import { formatAbsolute, toIsoSecond } from '../format/time'

/**
 * Says, without a dismiss button, that the page is not using the real clock.
 *
 * The committed fixtures were scanned at a fixed instant, so against a real clock
 * they are permanently stale and every countdown reads zero. `?now=` makes them
 * demonstrable. It is the single most misleading thing this site can do, so it is
 * never silent and never dismissible: whenever it is set, this banner is on the
 * page, and it links back to the real clock.
 *
 * It is one line rather than a titled banner, and that is a deliberate trade. This
 * sits above the list, where the page's whole budget is the first screen, and a
 * heading plus two paragraphs pushed the names below the fold on its own. The
 * region keeps its accessible name, so a screen reader still reaches it as a named
 * landmark; what it loses is the space, not the announcement.
 *
 * The sentence is short enough to hold one line at desktop width for the same reason.
 * It says where the time came from by saying where it did not, and the link beside it
 * is the way back, so the clause naming the URL was two lines' worth of restatement.
 */
export interface SimulatedClockNoticeProps {
  readonly now: Date
  readonly realHref: string
}

export function SimulatedClockNotice({ now, realHref }: SimulatedClockNoticeProps): ReactNode {
  return (
    <section aria-label="Showing a simulated time" className="clockline">
      <p className="clockline__text">
        <strong>Simulated time.</strong> Ages and countdowns are measured from{' '}
        <time className="mono" dateTime={toIsoSecond(now)}>
          {formatAbsolute(now)}
        </time>
        , not from your clock.
      </p>
      <a className="clockline__out" href={realHref}>
        Use the real time instead
      </a>
    </section>
  )
}
