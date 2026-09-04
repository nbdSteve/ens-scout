import { codePointLength, compareNames } from '../format/text'
import type { Status } from '../snapshot/contract'
import type { SnapshotResult } from '../snapshot/types'
import { PAGE_SIZE, type QueryState } from './query'
import { viewOrDefault, type SortDirection, type SortId } from './views'

/**
 * Filtering, sorting, and paging - all of it pure, so the same query always
 * produces the same rows and a test can assert that without a browser.
 */

/** Label length in code points, so an astral character counts once. */
export function labelLength(result: SnapshotResult): number {
  return codePointLength(result.label)
}

function sortKey(result: SnapshotResult, sort: SortId): Date | null {
  switch (sort) {
    case 'name':
      return null
    case 'expiry':
      return result.expiry
    case 'grace-end':
      return result.graceEnds
    case 'premium-end':
      return result.premiumEnds
  }
}

/**
 * Sorts a copy. Names go through `compareNames`, which is the snapshot's own
 * canonical order rather than the browser's UTF-16 one, so the list a visitor reads
 * is the order that was published. A name with no value for the chosen sort goes
 * last in both directions: a missing expiry is not an early expiry, and burying
 * those rows under the ones the visitor asked to see is the honest placement.
 */
export function sortResults(
  results: readonly SnapshotResult[],
  sort: SortId,
  direction: SortDirection,
): SnapshotResult[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...results].sort((left, right) => {
    if (sort !== 'name') {
      const a = sortKey(left, sort)
      const b = sortKey(right, sort)
      if (a === null && b !== null) {
        return 1
      }
      if (a !== null && b === null) {
        return -1
      }
      if (a !== null && b !== null && a.getTime() !== b.getTime()) {
        return (a.getTime() - b.getTime()) * sign
      }
    }
    // Name is the tie-break as well as a sort, which makes every order total and
    // therefore stable across renders.
    return compareNames(left.name, right.name) * sign
  })
}

export interface FilterContext {
  /** Source id for each name, or null when attribution could not be verified. */
  readonly sourceIdByName: ReadonlyMap<string, string> | null
}

/** Keeps the results the query admits, in snapshot order. */
export function filterResults(
  results: readonly SnapshotResult[],
  query: QueryState,
  context: FilterContext,
): SnapshotResult[] {
  const view = viewOrDefault(query.view)
  const viewStatuses: readonly Status[] = view.statuses
  const chosen: readonly Status[] = query.statuses

  return results.filter((result) => {
    if (viewStatuses.length > 0 && !viewStatuses.includes(result.status)) {
      return false
    }
    if (chosen.length > 0 && !chosen.includes(result.status)) {
      return false
    }
    if (query.search !== '' && !result.label.includes(query.search)) {
      return false
    }
    const length = labelLength(result)
    if (query.length.min !== null && length < query.length.min) {
      return false
    }
    if (query.length.max !== null && length > query.length.max) {
      return false
    }
    if (query.list !== null) {
      // With no verified attribution the filter cannot be honoured. It is not
      // silently ignored either: `App` raises an advisory above the list saying the
      // link named a list this snapshot cannot resolve, so the full set of rows is
      // never mistaken for the filtered one.
      if (context.sourceIdByName === null) {
        return true
      }
      if (context.sourceIdByName.get(result.name) !== query.list) {
        return false
      }
    }
    return true
  })
}

export interface Page {
  /** Every result the query admits, sorted. */
  readonly matched: readonly SnapshotResult[]
  /** The slice on the current page. */
  readonly rows: readonly SnapshotResult[]
  readonly total: number
  readonly pageCount: number
  /** The page actually shown, clamped into range. */
  readonly page: number
  readonly firstRow: number
  readonly lastRow: number
}

/** Filters, sorts, and takes the requested page. */
export function applyQuery(
  results: readonly SnapshotResult[],
  query: QueryState,
  context: FilterContext,
): Page {
  const matched = sortResults(filterResults(results, query, context), query.sort, query.direction)
  const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE))
  // A page number past the end is clamped rather than rejected, so a shared link
  // whose snapshot has since shrunk still shows rows.
  const page = Math.min(Math.max(1, query.page), pageCount)
  const start = (page - 1) * PAGE_SIZE
  const rows = matched.slice(start, start + PAGE_SIZE)
  return {
    matched,
    rows,
    total: matched.length,
    pageCount,
    page,
    firstRow: matched.length === 0 ? 0 : start + 1,
    lastRow: start + rows.length,
  }
}

/** How many results each status has, within the current view but before its own filter. */
export function countByStatus(
  results: readonly SnapshotResult[],
  query: QueryState,
  context: FilterContext,
): Map<Status, number> {
  const withoutStatusFilter = filterResults(results, { ...query, statuses: [] }, context)
  const counts = new Map<Status, number>()
  for (const result of withoutStatusFilter) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1)
  }
  return counts
}
