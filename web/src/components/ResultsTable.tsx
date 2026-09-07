import type { ReactNode } from 'react'
import type { SnapshotResult } from '../snapshot/types'
import type { SortDirection, SortId } from '../state/views'
import { ResultRow } from './ResultRow'
import type { VerifyBinding } from './verification'

/**
 * The names, as a table.
 *
 * It is a real `<table>` with a caption, column headers, and a row header per name,
 * because that is what it is: three facts about each of many names, which a screen
 * reader should be able to navigate by column. A grid of `<div>`s would look the
 * same and navigate far worse.
 *
 * The sort control lives in `Toolbar` rather than in these headers. There is one
 * sort, it is part of the shareable link, and putting a second way to set it in the
 * headers would mean two mechanisms to keep agreed with the URL. What the headers
 * do carry is `aria-sort`, which reports the order the rows are actually in - and
 * the boundary column reports it for whichever date sort is active, because that
 * column is what all three date sorts order by.
 */
export interface ResultsTableProps {
  readonly rows: readonly SnapshotResult[]
  readonly now: Date
  readonly sort: SortId
  readonly direction: SortDirection
  /** Null when the deployment has no verifier, which is fixture mode. */
  readonly verify: VerifyBinding | null
}

function ariaSort(active: boolean, direction: SortDirection): 'ascending' | 'descending' | 'none' {
  if (!active) {
    return 'none'
  }
  return direction === 'asc' ? 'ascending' : 'descending'
}

export function ResultsTable({ rows, now, sort, direction, verify }: ResultsTableProps): ReactNode {
  const table = (
    <table className="results">
      {/*
        Present for a screen reader, not drawn. This is the table's accessible name, so
        a reader who arrives at the table out of context learns what it is and where the
        authority is. It is hidden visually because the trust line on the first screen
        already says the same thing at greater length, and a second copy of it directly
        above the column headers cost two lines to say nothing new. See
        `.results__caption`, which hides it by clipping rather than by `display: none`
        so the name survives.

        It no longer claims that each name is a link, because a name is one only while a
        fresh check covers it. Saying otherwise would be the caption stating something
        this page has not established, which is the same failure the gate exists to stop.
      */}
      <caption className="results__caption">
        A record of one scan, not a fresh check. A name links to the ENS app once a fresh check
        covers it, and ENS is the only authority on whether it can be registered.
      </caption>
      <thead>
        {/*
          The header cells carry the column's own class rather than relying on their
          position, because the first column is conditional. The proportions in the
          stylesheet are addressed by class for that reason: a `:first-child` width
          meant for the name landed on the tick box the moment a verifier existed.
        */}
        <tr>
          {verify !== null && (
            /*
              A header for the tick boxes, present but not drawn. A blank `<th>` leaves a
              screen reader announcing the column by position, and the boxes below it are
              the one control in the table.
            */
            <th className="results__pick" scope="col">
              <span className="visually-hidden">Select for a fresh check</span>
            </th>
          )}
          <th
            aria-sort={ariaSort(sort === 'name', direction)}
            className="results__name"
            scope="col"
          >
            Name
          </th>
          <th className="results__status" scope="col">
            Status at the scan time
          </th>
          <th
            aria-sort={ariaSort(sort !== 'name', direction)}
            className="results__next"
            scope="col"
          >
            What happens next
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((result) => (
          <ResultRow key={result.name} now={now} result={result} verify={verify} />
        ))}
      </tbody>
    </table>
  )

  if (verify === null) {
    return table
  }

  /*
   * With a tick column the table is four columns wide, and four columns do not fit at
   * 320 CSS px however hard the gutters are tightened, so it scrolls inside the page
   * rather than taking the page with it. `.results__scroll` says why that is the answer
   * and why it is only ever needed here.
   *
   * Focusable, and therefore named. Only the tick boxes are focusable in their own
   * right and they sit on the start edge, so without a stop of its own a keyboard user
   * could never bring the end column into view. `group` rather than `region`: this is
   * one control's worth of scrolling, not a section of the page, and a second landmark
   * named for the same names the section above it is named for would be one more stop
   * on a landmark list for no gain.
   */
  return (
    /*
      A tab stop on something that is not a control, which is the one case the rule below
      exists to allow: a region that scrolls has to be reachable, and there is no
      interactive element to hang that on. `jsx-a11y` cannot tell a scroll container from
      a decorative div, so the exception is stated here rather than opened repository-wide.
    */
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div aria-label="Names" className="results__scroll" role="group" tabIndex={0}>
      {table}
    </div>
  )
}
