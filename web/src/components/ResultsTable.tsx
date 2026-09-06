import type { ReactNode } from 'react'
import type { SnapshotResult } from '../snapshot/types'
import type { SortDirection, SortId } from '../state/views'
import { ResultRow } from './ResultRow'

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
}

function ariaSort(active: boolean, direction: SortDirection): 'ascending' | 'descending' | 'none' {
  if (!active) {
    return 'none'
  }
  return direction === 'asc' ? 'ascending' : 'descending'
}

export function ResultsTable({ rows, now, sort, direction }: ResultsTableProps): ReactNode {
  return (
    <table className="results">
      {/*
        Present for a screen reader, not drawn. This is the table's accessible name, so
        a reader who arrives at the table out of context learns what it is and where the
        authority is. It is hidden visually because the trust line on the first screen
        already says the same thing at greater length, and a second copy of it directly
        above the column headers cost two lines to say nothing new. See
        `.results__caption`, which hides it by clipping rather than by `display: none`
        so the name survives.
      */}
      <caption className="results__caption">
        A record of one scan, not a fresh check. Each name links to the ENS app, the only authority
        on whether it can be registered.
      </caption>
      <thead>
        <tr>
          <th aria-sort={ariaSort(sort === 'name', direction)} scope="col">
            Name
          </th>
          <th scope="col">Status at the scan time</th>
          <th aria-sort={ariaSort(sort !== 'name', direction)} scope="col">
            What happens next
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((result) => (
          <ResultRow key={result.name} now={now} result={result} />
        ))}
      </tbody>
    </table>
  )
}
