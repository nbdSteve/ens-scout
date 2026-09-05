import { NAME_SUFFIX, STATUSES, isStatus, type Status } from '../snapshot/contract'
import {
  DEFAULT_VIEW,
  DEFAULT_VIEW_ID,
  findView,
  isSortDirection,
  isSortId,
  viewOrDefault,
  type SortDirection,
  type SortId,
} from './views'

/**
 * The query string is the state.
 *
 * Every control on the page - the view, the search box, the status checkboxes,
 * the length range, the source list, the sort, the page - lives in the URL, so
 * any screen a visitor is looking at can be copied out of the address bar and
 * sent to someone else. Holding this in React state and mirroring it to the URL
 * would make the two able to disagree; holding it in the URL and deriving React
 * state from it cannot.
 *
 * Serialization is canonical: a parameter at its default is omitted, statuses are
 * written in the published order rather than the order they were clicked, and
 * `serializeQuery(parseQuery(s))` is stable for any input. Without that, two
 * visitors who made the same choices in a different order would produce different
 * links to the same view.
 */

/** How many rows one page shows. */
export const PAGE_SIZE = 50

export interface LengthRange {
  readonly min: number | null
  readonly max: number | null
}

/** A range whose bounds cross, so no label length can satisfy both of them. */
export interface InvertedRange extends LengthRange {
  readonly min: number
  readonly max: number
}

/**
 * Whether a range names no label length at all.
 *
 * One predicate, because the parser reports this state and the filter has to skip
 * it. Two copies of the condition could disagree, and either way round the visitor
 * loses: a range reported as not applied but applied anyway empties the list, and a
 * range applied without being reported empties it with no explanation.
 *
 * The bounds themselves are kept either way. A visitor who has set a longest length
 * and then types a shortest above it must not have to go and find the first value
 * again, so this is a state the query is allowed to hold rather than one the link
 * sanitiser silently repairs.
 */
export function isInvertedRange(length: LengthRange): length is InvertedRange {
  return length.min !== null && length.max !== null && length.min > length.max
}

/**
 * What could not be applied about a state, as opposed to about the text it was read
 * from.
 *
 * The difference decides how long the notice lives. An unknown view or an unusable
 * page number exists only in the link that named it: the canonical rewrite drops it,
 * so it can only ever be reported about the arrival. An inverted range survives
 * serialization, so it is still in the URL after that rewrite, after an unrelated
 * filter change, and after a back navigation - and it is still not being applied.
 * Reporting it on the arrival path alone would leave a visitor on a screen whose two
 * bounds are set, whose length filter is silently doing nothing, and which says so
 * nowhere.
 *
 * Derived rather than carried, so any caller holding a state can ask.
 */
export function describeQueryState(state: QueryState): string[] {
  const warnings: string[] = []
  if (isInvertedRange(state.length)) {
    // Named by its values rather than by where they came from, because a keystroke
    // reaches this the same way a shared link does, and the numbers are what tell the
    // visitor which of the two bounds to change.
    warnings.push(
      `Length range not applied: shortest ${String(state.length.min)} is above longest ${String(state.length.max)}.`,
    )
  }
  return warnings
}

export interface QueryState {
  readonly view: string
  /** Search text, already lowercased and stripped of a `.eth` suffix. */
  readonly search: string
  /** Statuses to keep, within the view's own set. Empty means the whole view. */
  readonly statuses: readonly Status[]
  readonly length: LengthRange
  /** Source list id, or null for every list. */
  readonly list: string | null
  readonly sort: SortId
  readonly direction: SortDirection
  /** One-based page number. */
  readonly page: number
  /**
   * A clock to render against, instead of the real one.
   *
   * The committed fixtures were scanned at a fixed instant, so against a real
   * clock they are permanently stale and every countdown reads zero. This makes
   * the fixtures demonstrable and the browser tests deterministic. It is always
   * honoured and always announced: whenever it is set, the page shows a
   * non-dismissible notice, because a site that silently rendered a chosen time
   * as if it were now would be the most misleading thing here.
   */
  readonly now: Date | null
}

/** Longest search text accepted, so a hostile URL cannot make the page do work. */
const MAX_SEARCH_LENGTH = 128

/**
 * Shortest and longest label length a range bound may name.
 *
 * Exported because the toolbar's two spinbuttons advertise the same span, and a toolbar
 * that offered a wider one than the parser accepts would let a visitor type a number
 * that is then reported back to them as unusable.
 */
export const MIN_LENGTH_BOUND = 1
export const MAX_LENGTH_BOUND = 64

/** Which end of the range a bound is, and what a reader calls it. */
export const BOUND_LABEL = { min: 'Shortest length', max: 'Longest length' } as const

export type BoundEnd = keyof typeof BOUND_LABEL

/** How much of an unusable bound is quoted back, since a link can carry anything. */
const MAX_BOUND_ECHO = 8

/**
 * The bound a string names, or null when it names none.
 *
 * The one reader. A value typed into a box and the same value carried in a link are
 * judged by this and reported in the words below, so the two paths cannot come to
 * different conclusions about the same characters.
 */
export function readLengthBound(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) {
    return null
  }
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= MIN_LENGTH_BOUND && value <= MAX_LENGTH_BOUND
    ? value
    : null
}

/**
 * Why a bound was not applied.
 *
 * The requirement rather than the span, because a span is a false explanation for a
 * value already inside it: 3.5 sits between 1 and 64 and is still not a label length.
 * The value is quoted so the visitor knows which of the two boxes to change, and it is
 * quoted short because a link can carry any amount of text.
 */
export function boundNotApplied(end: BoundEnd, raw: string): string {
  return `${BOUND_LABEL[end]} not applied: ${raw.slice(0, MAX_BOUND_ECHO)} is not a whole number from ${String(MIN_LENGTH_BOUND)} to ${String(MAX_LENGTH_BOUND)}.`
}

export const PARAM = {
  view: 'view',
  search: 'q',
  status: 'status',
  minLength: 'min',
  maxLength: 'max',
  list: 'list',
  sort: 'sort',
  direction: 'dir',
  page: 'page',
  now: 'now',
} as const

export const DEFAULT_QUERY: QueryState = {
  view: DEFAULT_VIEW_ID,
  search: '',
  statuses: [],
  length: { min: null, max: null },
  list: null,
  sort: viewOrDefault(DEFAULT_VIEW_ID).defaultSort,
  direction: 'asc',
  page: 1,
  now: null,
}

/** A search term is matched against labels, so it is normalized like one. */
export function normalizeSearch(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const withoutSuffix = trimmed.endsWith(NAME_SUFFIX)
    ? trimmed.slice(0, -NAME_SUFFIX.length)
    : trimmed
  return withoutSuffix.slice(0, MAX_SEARCH_LENGTH)
}

function parseBound(raw: string | null, end: BoundEnd, warnings: string[]): number | null {
  if (raw === null || raw === '') {
    return null
  }
  const value = readLengthBound(raw)
  if (value === null) {
    warnings.push(boundNotApplied(end, raw))
  }
  return value
}

export interface ParsedQuery {
  readonly state: QueryState
  /**
   * What in the query could not be applied. Shown to the visitor, because a screen
   * that quietly returns different rows than it was asked for is worse than one that
   * says which part of the request did not take.
   */
  readonly warnings: readonly string[]
}

/** Reads state out of a query string. Never throws: an unusable value is dropped and reported. */
export function parseQuery(search: string): ParsedQuery {
  const params = new URLSearchParams(search)
  const warnings: string[] = []

  const requestedView = params.get(PARAM.view)
  if (requestedView !== null && findView(requestedView) === null) {
    warnings.push(`The link asked for an unknown view, so ${DEFAULT_VIEW.title} is shown instead.`)
  }
  const view = viewOrDefault(requestedView ?? DEFAULT_VIEW_ID)

  const allowed: readonly Status[] = view.statuses.length === 0 ? STATUSES : view.statuses
  const requestedStatuses = new Set<Status>()
  let droppedStatus = false
  for (const raw of params.getAll(PARAM.status).flatMap((value) => value.split(','))) {
    const candidate = raw.trim()
    if (candidate === '') {
      continue
    }
    if (isStatus(candidate) && allowed.includes(candidate)) {
      requestedStatuses.add(candidate)
    } else {
      droppedStatus = true
    }
  }
  if (droppedStatus) {
    warnings.push('Ignored a status in the link that this view does not show.')
  }
  // A selection covering the whole view is the same as no selection, and writing
  // it as no selection keeps one canonical URL per visible set of rows.
  const statuses =
    requestedStatuses.size === allowed.length
      ? []
      : STATUSES.filter((s) => requestedStatuses.has(s))

  const length: LengthRange = {
    min: parseBound(params.get(PARAM.minLength), 'min', warnings),
    max: parseBound(params.get(PARAM.maxLength), 'max', warnings),
  }

  const rawList = params.get(PARAM.list)
  const list = rawList === null || rawList.trim() === '' ? null : rawList.trim()

  const rawSort = params.get(PARAM.sort)
  if (rawSort !== null && !isSortId(rawSort)) {
    warnings.push('Ignored an unknown sort in the link.')
  }
  const sort = isSortId(rawSort) ? rawSort : view.defaultSort

  const rawDirection = params.get(PARAM.direction)
  if (rawDirection !== null && !isSortDirection(rawDirection)) {
    warnings.push('Ignored an unknown sort direction in the link.')
  }
  const direction = isSortDirection(rawDirection) ? rawDirection : 'asc'

  const rawPage = params.get(PARAM.page)
  let page = 1
  if (rawPage !== null && rawPage !== '') {
    const parsed = Number.parseInt(rawPage, 10)
    if (/^[0-9]+$/.test(rawPage) && Number.isSafeInteger(parsed) && parsed >= 1) {
      page = parsed
    } else {
      warnings.push('Ignored an unusable page number in the link.')
    }
  }

  const rawNow = params.get(PARAM.now)
  let now: Date | null = null
  if (rawNow !== null && rawNow !== '') {
    const parsed = new Date(rawNow)
    if (Number.isNaN(parsed.getTime())) {
      warnings.push('Ignored an unreadable simulated time in the link.')
    } else {
      now = parsed
    }
  }

  const state: QueryState = {
    view: view.id,
    search: normalizeSearch(params.get(PARAM.search) ?? ''),
    statuses,
    length,
    list,
    sort,
    direction,
    page,
    now,
  }
  // The state's own warnings come last, and are the only ones any caller can re-derive:
  // they outlive the link they were read from.
  return { state, warnings: [...warnings, ...describeQueryState(state)] }
}

/** Writes state as a canonical query string, including the leading `?`, or `''`. */
export function serializeQuery(state: QueryState): string {
  const view = viewOrDefault(state.view)
  const params = new URLSearchParams()

  if (view.id !== DEFAULT_VIEW_ID) {
    params.set(PARAM.view, view.id)
  }
  if (state.search !== '') {
    params.set(PARAM.search, state.search)
  }
  if (state.statuses.length > 0) {
    params.set(PARAM.status, STATUSES.filter((s) => state.statuses.includes(s)).join(','))
  }
  if (state.length.min !== null) {
    params.set(PARAM.minLength, String(state.length.min))
  }
  if (state.length.max !== null) {
    params.set(PARAM.maxLength, String(state.length.max))
  }
  if (state.list !== null) {
    params.set(PARAM.list, state.list)
  }
  if (state.sort !== view.defaultSort) {
    params.set(PARAM.sort, state.sort)
  }
  if (state.direction !== 'asc') {
    params.set(PARAM.direction, state.direction)
  }
  if (state.page > 1) {
    params.set(PARAM.page, String(state.page))
  }
  if (state.now !== null) {
    params.set(PARAM.now, `${state.now.toISOString().slice(0, 19)}Z`)
  }

  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/**
 * Whether anything is hiding rows the view would otherwise show.
 *
 * The view itself is not a filter by this measure, and neither are the sort, the
 * page, or the simulated clock: none of them is something a visitor would need to
 * clear to see the rows they expected. Shared by the reset link and the empty
 * state, so the two cannot disagree about whether there is anything to clear.
 */
export function isFiltered(state: QueryState): boolean {
  return (
    state.search !== '' ||
    state.statuses.length > 0 ||
    state.length.min !== null ||
    state.length.max !== null ||
    state.list !== null
  )
}

/** The change that clears every filter `isFiltered` reports on. */
export const CLEAR_FILTERS: Partial<QueryState> = {
  search: '',
  statuses: [],
  length: { min: null, max: null },
  list: null,
  page: 1,
}

/**
 * Applies a change. Anything that alters which rows are shown resets to page one,
 * because a visitor who narrows a list while on page nine should not be shown an
 * empty page.
 */
export function updateQuery(state: QueryState, change: Partial<QueryState>): QueryState {
  const next: QueryState = { ...state, ...change }
  const keepsPage = Object.keys(change).every((key) => key === 'page' || key === 'now')
  if (keepsPage) {
    return next
  }
  // Switching view can invalidate the sort, since a view's default sort is part
  // of its identity. An explicitly chosen sort is kept; a defaulted one moves.
  const sort =
    change.view !== undefined &&
    change.sort === undefined &&
    state.sort === viewOrDefault(state.view).defaultSort
      ? viewOrDefault(next.view).defaultSort
      : next.sort
  // A status selection belongs to the view it was made in.
  const statuses = change.view !== undefined && change.statuses === undefined ? [] : next.statuses
  return { ...next, sort, statuses, page: 1 }
}
