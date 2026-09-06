import type { ReactNode } from 'react'
import type { Status } from '../snapshot/contract'
import { STATUS_LABEL, STATUS_TONE } from '../snapshot/lifecycle'

/**
 * One published status, as a pill.
 *
 * The pill carries the words as well as the colour, because colour alone would
 * exclude anyone who cannot tell the tones apart. It deliberately does not repeat
 * the full status description: `SummaryCounts` states each description once at the
 * top of the page, and repeating it on every row would flood a screen reader
 * reading a table of fifty names.
 */
export interface StatusPillProps {
  readonly status: Status
}

export function StatusPill({ status }: StatusPillProps): ReactNode {
  return <span className={`badge badge--${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
}
