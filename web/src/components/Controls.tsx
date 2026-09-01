import type { ChangeEvent, ReactNode } from 'react'
import { STATUSES, type Status } from '../snapshot/contract'
import { STATUS_LABEL } from '../snapshot/lifecycle'
import type { Attribution } from '../snapshot/attribution'
import type { SourceList } from '../snapshot/types'
import { normalizeSearch, type QueryState } from '../state/query'
import { useDraft } from '../state/useDraft'
import { SORT_IDS, SORT_LABEL, isSortId, viewOrDefault, type SortId } from '../state/views'

/**
 * Search, status, length, source list, and sort.
 *
 * Every control writes to the URL and reads back from it, so the address bar
 * always holds a link that reproduces the screen and the back button undoes any
 * one of them. Nothing here is a form to submit: each change applies at once,
 * which is why there is no submit button to look for.
 *
 * The search box and the two length bounds replace the current history entry
 * instead of adding one. Typing eight characters should not cost eight presses of
 * the back button to escape.
 *
 * The source-list control is hidden, with its reason stated, when the snapshot
 * does not let each name be attributed to exactly one list. Offering a filter that
 * silently could not be applied would be worse than not offering it.
 */
export interface ControlsProps {
  readonly query: QueryState
  readonly setQuery: (change: Partial<QueryState>, options?: { replace?: boolean }) => void
  /** Result counts per status, within the current view and before its status filter. */
  readonly statusCounts: ReadonlyMap<Status, number>
  readonly sources: readonly SourceList[]
  readonly attribution: Attribution
  /** Rows the current query matches, for the summary line. */
  readonly total: number
  /** Link back to the unfiltered view, preserving any simulated clock. */
  readonly resetHref: string
}

/** Shortest and longest label length a bound may name. Mirrors `parseQuery`. */
const MIN_BOUND = 1
const MAX_BOUND = 64

/** Reads a length bound out of an input. Anything unusable clears the bound. */
function readBound(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^[0-9]{1,2}$/.test(trimmed)) {
    return null
  }
  const value = Number.parseInt(trimmed, 10)
  return value >= MIN_BOUND && value <= MAX_BOUND ? value : null
}

function boundText(value: number | null): string {
  return value === null ? '' : String(value)
}

/**
 * What the two sort directions are called. `asc` and `desc` are meaningless to a
 * reader, and "ascending" is worse for a date column than for a name column, so
 * each sort names its own two ends.
 */
const DIRECTION_LABEL: Readonly<Record<SortId, { asc: string; desc: string }>> = {
  name: { asc: 'A to Z', desc: 'Z to A' },
  expiry: { asc: 'Soonest first', desc: 'Latest first' },
  'grace-end': { asc: 'Soonest first', desc: 'Latest first' },
  'premium-end': { asc: 'Soonest first', desc: 'Latest first' },
}

export function Controls({
  query,
  setQuery,
  statusCounts,
  sources,
  attribution,
  total,
  resetHref,
}: ControlsProps): ReactNode {
  const view = viewOrDefault(query.view)
  const statuses: readonly Status[] = view.statuses.length === 0 ? STATUSES : view.statuses

  const search = useDraft(query.search)
  const min = useDraft(boundText(query.length.min))
  const max = useDraft(boundText(query.length.max))

  const onSearch = (event: ChangeEvent<HTMLInputElement>): void => {
    const typed = event.target.value
    const committed = normalizeSearch(typed)
    search.setText(typed, committed)
    setQuery({ search: committed }, { replace: true })
  }

  const onBound =
    (which: 'min' | 'max') =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const typed = event.target.value
      const committed = readBound(typed)
      if (which === 'min') {
        min.setText(typed, boundText(committed))
        setQuery({ length: { ...query.length, min: committed } }, { replace: true })
        return
      }
      max.setText(typed, boundText(committed))
      setQuery({ length: { ...query.length, max: committed } }, { replace: true })
    }

  const onStatus = (status: Status, checked: boolean): void => {
    const next = checked
      ? STATUSES.filter((s) => s === status || query.statuses.includes(s))
      : query.statuses.filter((s) => s !== status)
    // Selecting every status in the view is the same as selecting none, and
    // `updateQuery` writes it as none so the link stays canonical.
    setQuery({ statuses: next })
  }

  const isFiltered =
    query.search !== '' ||
    query.statuses.length > 0 ||
    query.length.min !== null ||
    query.length.max !== null ||
    query.list !== null

  return (
    <section aria-labelledby="controls-heading" className="card controls">
      <div>
        <h2 className="card__title" id="controls-heading">
          Narrow the list
        </h2>
        <p className="prose">
          Each change is written to the address bar, so the link in it always reproduces what you
          are looking at.
        </p>
      </div>

      <div className="controls__grid">
        <div className="field">
          <label className="field__label" htmlFor="control-search">
            Search names
          </label>
          <input
            aria-describedby="control-search-hint"
            autoComplete="off"
            className="input"
            id="control-search"
            inputMode="search"
            onChange={onSearch}
            placeholder="zap"
            spellCheck={false}
            type="search"
            value={search.text}
          />
          <p className="field__hint" id="control-search-hint">
            Matches anywhere in the label. Case is ignored and a trailing <code>.eth</code> is
            dropped.
          </p>
        </div>

        <div className="field">
          <span className="field__label" id="control-length-label">
            Label length
          </span>
          <div aria-labelledby="control-length-label" className="range" role="group">
            <label className="visually-hidden" htmlFor="control-min">
              Shortest label length
            </label>
            <input
              className="input mono"
              id="control-min"
              inputMode="numeric"
              max={MAX_BOUND}
              min={MIN_BOUND}
              onChange={onBound('min')}
              placeholder="any"
              type="number"
              value={min.text}
            />
            <span aria-hidden="true" className="range__to">
              to
            </span>
            <label className="visually-hidden" htmlFor="control-max">
              Longest label length
            </label>
            <input
              className="input mono"
              id="control-max"
              inputMode="numeric"
              max={MAX_BOUND}
              min={MIN_BOUND}
              onChange={onBound('max')}
              placeholder="any"
              type="number"
              value={max.text}
            />
          </div>
          <p className="field__hint">
            Counted in characters, without the <code>.eth</code> suffix.
          </p>
        </div>

        <div className="field">
          {attribution.available ? (
            <>
              <label className="field__label" htmlFor="control-list">
                Source list
              </label>
              <select
                className="select"
                id="control-list"
                onChange={(event) => {
                  setQuery({ list: event.target.value === '' ? null : event.target.value })
                }}
                value={query.list ?? ''}
              >
                <option value="">Every list</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.path} ({source.names.toLocaleString('en-GB')})
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              {/* No `for` here: there is no control to label, and a label pointing
                  at nothing would be announced as an empty field. */}
              <span className="field__label">Source list</span>
              <p className="field__hint">
                This snapshot does not say which list each name came from, so it cannot be filtered
                by list. Reason: {attribution.reason ?? 'attribution could not be verified'}.
              </p>
            </>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="control-sort">
            Sort by
          </label>
          <select
            className="select"
            id="control-sort"
            onChange={(event) => {
              if (isSortId(event.target.value)) {
                setQuery({ sort: event.target.value })
              }
            }}
            value={query.sort}
          >
            {SORT_IDS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABEL[sort]}
              </option>
            ))}
          </select>
          <button
            className="button button--quiet"
            onClick={() => {
              setQuery({ direction: query.direction === 'asc' ? 'desc' : 'asc' })
            }}
            type="button"
          >
            {DIRECTION_LABEL[query.sort][query.direction]}
            <span className="visually-hidden">
              . Press to sort{' '}
              {DIRECTION_LABEL[query.sort][query.direction === 'asc' ? 'desc' : 'asc']} instead.
            </span>
          </button>
        </div>
      </div>

      <fieldset className="fieldset">
        <legend className="fieldset__legend">Status at the scan time</legend>
        <div className="checkbox-list">
          {statuses.map((status) => (
            <label className="checkbox" key={status}>
              <input
                checked={query.statuses.includes(status)}
                onChange={(event) => {
                  onStatus(status, event.target.checked)
                }}
                type="checkbox"
                value={status}
              />
              <span>
                {STATUS_LABEL[status]}{' '}
                <span className="checkbox__count">
                  ({(statusCounts.get(status) ?? 0).toLocaleString('en-GB')})
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="field__hint">
          With none ticked, every status in this view is shown. These are the statuses the scan
          recorded, not a fresh check.
        </p>
      </fieldset>

      <div className="controls__footer">
        <p className="result-count" role="status">
          {total.toLocaleString('en-GB')} {total === 1 ? 'name matches' : 'names match'}
        </p>
        {isFiltered && <a href={resetHref}>Clear all filters</a>}
      </div>
    </section>
  )
}
