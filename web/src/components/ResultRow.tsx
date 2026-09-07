import type { ReactNode } from 'react'
import { splitAbsolute, toIsoSecond } from '../format/time'
import type { Status } from '../snapshot/contract'
import { nextBoundary } from '../snapshot/lifecycle'
import type { SnapshotResult } from '../snapshot/types'
import { labelLength } from '../state/filter'
import { Countdown } from './Countdown'
import { EnsAppLink } from './EnsAppLink'
import { StatusPill } from './StatusPill'
import { rowVerification, rowVerifyNote, type VerifyBinding } from './verification'

/**
 * One name.
 *
 * The three facts answer three questions in order: which name, what the scan found, and
 * what the scan recorded as happening next. Nothing is computed from anything else here -
 * the boundary comes from `nextBoundary`, which only picks whichever timestamp the
 * published status already points at.
 *
 * A fourth cell appears when the deployment has a verifier, and it changes what the name
 * cell is. The name is a link to ENS only while a fresh check covers it and has not
 * lapsed, which `verify/gate.ts` decides; otherwise it is plain text. A scan result is a
 * record of a moment that has passed, and sending a visitor out to register on the
 * strength of one is the thing this page must not do.
 *
 * The fresh status sits in the status cell beside the scan's, under a label naming the
 * instant it was read. Two statuses in one cell is the point: they are answers to the
 * same question at different times, they can disagree, and putting the fresh one in a
 * column of its own would have implied it belonged to the same scan.
 */
export interface ResultRowProps {
  readonly result: SnapshotResult
  readonly now: Date
  /** Null when the deployment has no verifier, which is fixture mode. */
  readonly verify: VerifyBinding | null
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

export function ResultRow({ result, now, verify }: ResultRowProps): ReactNode {
  const boundary = nextBoundary(result)
  const length = labelLength(result)
  const row = verify === null ? null : rowVerification(result.name, verify, now)
  const note = row === null ? null : rowVerifyNote(row)
  /*
   * The last fresh answer, whether or not it still opens the link. A lapsed check is
   * still the newest thing anyone read, and its label carries the instant, so showing it
   * states a fact rather than implying a currency it has lost. The name cell says it has
   * lapsed, and the link is gone either way.
   */
  const fresh = row?.verdict.allowed === true ? row.verdict.verified : null
  const lapsed =
    row !== null && !row.verdict.allowed && row.verdict.reason === 'expired'
      ? row.verdict.verified
      : null
  const checked = fresh ?? lapsed

  return (
    <tr className="results__row">
      {verify !== null && row !== null && (
        <td className="results__pick">
          <label className="verify-box">
            <input
              checked={row.selected}
              disabled={!row.selectable}
              onChange={() => {
                verify.onToggle(result.name)
              }}
              type="checkbox"
            />
            <span className="visually-hidden">Fresh check {result.name}</span>
          </label>
        </td>
      )}
      <th className="results__name" scope="row">
        {row?.verdict.allowed === true ? (
          <EnsAppLink name={result.name} />
        ) : (
          /*
           * Plain text, and deliberately not a disabled link. There is nowhere to go
           * yet, so there is nothing to disable: a greyed-out link would still read as
           * a link to a screen reader and would still invite a click.
           */
          <span className="results__unlinked">
            <span className="mono">{result.name}</span>
          </span>
        )}
        {/*
          The spaces are explicit text nodes, because these spans stack as separate
          lines on screen but sit adjacent in the accessible name. Without them a
          reader announces the cell as `aaaa.eth4 charactersNo fresh check`, and the
          layout gives no hint that anything is missing.
        */}{' '}
        <span className="results__length">
          {length} {length === 1 ? 'character' : 'characters'}
        </span>
        {note !== null && (
          <>
            {' '}
            <span className="results__verify">{note}</span>
          </>
        )}
      </th>
      <td className="results__status">
        <StatusPill status={result.status} />
        {checked !== null && (
          <span className="results__fresh">
            <span className="results__fresh-label">
              Fresh check{' '}
              <time className="mono" dateTime={toIsoSecond(checked.checkedAt)}>
                {splitAbsolute(checked.checkedAt).clock}
              </time>
            </span>
            <StatusPill status={checked.result.status} />
          </span>
        )}
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
