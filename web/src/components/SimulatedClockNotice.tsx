import type { ReactNode } from 'react'
import { formatAbsolute, toIsoSecond } from '../format/time'
import { Notice } from './Notice'

/**
 * Says, loudly and without a dismiss button, that the page is not using the real
 * clock.
 *
 * The committed fixtures were scanned at a fixed instant, so against a real clock
 * they are permanently stale and every countdown reads zero. `?now=` makes them
 * demonstrable. It is the single most misleading thing this site can do, so it is
 * never silent and never dismissible: whenever it is set, this banner is on the
 * page, and it links back to the real clock.
 */
export interface SimulatedClockNoticeProps {
  readonly now: Date
  readonly realHref: string
}

export function SimulatedClockNotice({ now, realHref }: SimulatedClockNoticeProps): ReactNode {
  return (
    <Notice tone="danger" title="Showing a simulated time">
      <p>
        Every age and countdown on this page is measured from{' '}
        <time className="mono" dateTime={toIsoSecond(now)}>
          {formatAbsolute(now)}
        </time>
        , which came from the link you followed, not from your clock. Nothing here reflects the
        present moment.
      </p>
      <p>
        <a href={realHref}>Use the real time instead</a>
      </p>
    </Notice>
  )
}
