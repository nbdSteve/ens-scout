import type { ReactNode } from 'react'
import type { Status } from '../snapshot/contract'
import { nextBoundary } from '../snapshot/lifecycle'
import type { SnapshotResult } from '../snapshot/types'
import { labelLength } from '../state/filter'
import { Countdown } from './Countdown'
import { EnsAppLink } from './EnsAppLink'
import { StatusPill } from './StatusPill'

/**
 * One name.
 *
 * The three cells answer the three questions in order: which name, what the scan
 * found, and what the scan recorded as happening next. Nothing is computed from
 * anything else here - the boundary comes from `nextBoundary`, which only picks
 * whichever timestamp the published status already points at.
 */
export interface ResultRowProps {
  readonly result: SnapshotResult
  readonly now: Date
}

/**
 * What to say when the scan recorded no next timestamp. `available` and `unknown`
 * have none by definition; a lifecycle status with a missing timestamp is a gap in
 * the index, and saying so is better than leaving the cell blank.
 */
const NO_BOUNDARY_REASON: Readonly<Partial<Record<Status, string>>> = {
  available: 'The scan recorded nothing further. Confirm the current price on the ENS app.',
  unknown: 'The subgraph had no usable expiry, so no date could be recorded.',
}

export function ResultRow({ result, now }: ResultRowProps): ReactNode {
  const boundary = nextBoundary(result)
  const length = labelLength(result)

  return (
    <tr className="results__row">
      <th className="results__name" scope="row">
        <EnsAppLink name={result.name} />
        <span className="results__length">
          {length} {length === 1 ? 'character' : 'characters'}
        </span>
      </th>
      <td className="results__status">
        <StatusPill status={result.status} />
      </td>
      <td className="results__next">
        {boundary === null ? (
          <p className="countdown__note">
            {NO_BOUNDARY_REASON[result.status] ?? 'The scan recorded no date for this name.'}
          </p>
        ) : (
          <Countdown boundary={boundary} now={now} />
        )}
      </td>
    </tr>
  )
}
