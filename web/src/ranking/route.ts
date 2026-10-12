import { DEFAULT_QUERY, type QueryState } from '../state/query'

/**
 * The hero belongs only to the canonical landing state.
 *
 * Every field is compared explicitly so a new URL-backed discovery control is a
 * deliberate decision here rather than something that accidentally inherits the
 * entrance. The URL remains the authority: any applied search, filter, sort,
 * page, or preview clock starts at discovery.
 */
export function isCanonicalFeaturedRoute(query: QueryState): boolean {
  return (
    query.view === DEFAULT_QUERY.view &&
    query.search === DEFAULT_QUERY.search &&
    query.statuses.length === 0 &&
    query.length.min === null &&
    query.length.max === null &&
    query.list === null &&
    query.sort === DEFAULT_QUERY.sort &&
    query.direction === DEFAULT_QUERY.direction &&
    query.page === DEFAULT_QUERY.page &&
    query.now === null
  )
}
