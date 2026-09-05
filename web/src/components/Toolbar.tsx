import type { ChangeEvent, ReactNode } from 'react'
import { STATUSES, type Status } from '../snapshot/contract'
import { STATUS_LABEL } from '../snapshot/lifecycle'
import type { Attribution } from '../snapshot/attribution'
import type { SourceList } from '../snapshot/types'
import {
  isFiltered,
  MAX_LENGTH_BOUND,
  MIN_LENGTH_BOUND,
  normalizeSearch,
  readLengthBound,
  type BoundEnd,
  type QueryState,
} from '../state/query'
import { useDraft } from '../state/useDraft'
import { boundText, type LengthDrafts } from '../state/useLengthDrafts'
import { SORT_IDS, SORT_LABEL, isSortId, viewOrDefault, type SortId } from '../state/views'

/**
 * Search, length, status, source list, and sort, in one row plus a disclosure.
 *
 * Every control writes to the URL and reads back from it, so the address bar always
 * holds a link that reproduces the screen and the back button undoes any one of
 * them. Nothing here is a form to submit: each change applies at once, which is why
 * there is no submit button to look for.
 *
 * Only search and the two length bounds are visible. They are the two a visitor
 * reaches for on arrival, and they are the two that cost nothing to show: the rest
 * - source list, sort, and seven status checkboxes - is four times the height and
 * is what pushed the names off the first screen. It lives behind a native
 * `<details>`, so it needs no JavaScript, no focus trap, and no ARIA of its own,
 * and a reader who wants it finds one control rather than a wall.
 *
 * The search box and the two length bounds replace the current history entry
 * instead of adding one. Typing eight characters should not cost eight presses of
 * the back button to escape.
 *
 * The source-list control is hidden, with its reason stated, when the snapshot does
 * not let each name be attributed to exactly one list. Offering a filter that
 * silently could not be applied would be worse than not offering it.
 */
export interface ToolbarProps {
  readonly query: QueryState
  readonly setQuery: (change: Partial<QueryState>, options?: { replace?: boolean }) => void
  /** Result counts per status, within the current view and before its status filter. */
  readonly statusCounts: ReadonlyMap<Status, number>
  readonly sources: readonly SourceList[]
  readonly attribution: Attribution
  /** Link back to the unfiltered view, preserving any simulated clock. */
  readonly resetHref: string
  /**
   * The two length boxes. Held above this component because the advisory that reports an
   * unusable one renders above the list, and both have to be reading the same box.
   */
  readonly lengthDrafts: LengthDrafts
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

export function Toolbar({
  query,
  setQuery,
  statusCounts,
  sources,
  attribution,
  resetHref,
  lengthDrafts,
}: ToolbarProps): ReactNode {
  const view = viewOrDefault(query.view)
  const statuses: readonly Status[] = view.statuses.length === 0 ? STATUSES : view.statuses

  const search = useDraft(query.search)
  const { min, max } = lengthDrafts

  const onSearch = (event: ChangeEvent<HTMLInputElement>): void => {
    const typed = event.target.value
    const committed = normalizeSearch(typed)
    search.setText(typed, committed)
    setQuery({ search: committed }, { replace: true })
  }

  const onBound =
    (end: BoundEnd) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const typed = event.target.value
      /*
       * The keystroke is never refused and never rewritten: the box keeps what was typed
       * and the URL takes the bound it names, which is nothing at all when it names no
       * label length. `useLengthDrafts` is then the one thing that reports the gap, for
       * as long as the box still holds it. Only the end being edited is touched, so a
       * value this rejects cannot take the other bound down with it.
       *
       * The validity travels with the text because the text alone cannot say that a `.`
       * or a lone `-` is on screen: for those the field reports no value at all.
       */
      const badInput = event.target.validity.badInput
      const bound = readLengthBound(typed.trim())
      if (end === 'min') {
        min.setText(typed, boundText(bound), badInput)
        setQuery({ length: { ...query.length, min: bound } }, { replace: true })
        return
      }
      max.setText(typed, boundText(bound), badInput)
      setQuery({ length: { ...query.length, max: bound } }, { replace: true })
    }

  const onStatus = (status: Status, checked: boolean): void => {
    const next = checked
      ? STATUSES.filter((s) => s === status || query.statuses.includes(s))
      : query.statuses.filter((s) => s !== status)
    // Selecting every status in the view is the same as selecting none, and
    // `updateQuery` writes it as none so the link stays canonical.
    setQuery({ statuses: next })
  }

  const filtered = isFiltered(query)

  return (
    <section aria-labelledby="toolbar-heading" className="toolbar">
      {/* Hidden, not absent. The region needs a name for a screen reader to
          announce what it has landed in, and a visible heading over a single row
          of controls is a label for something that is already self-evident. */}
      <h2 className="visually-hidden" id="toolbar-heading">
        Narrow the list
      </h2>

      <div className="toolbar__row">
        <div className="toolbar__field toolbar__field--search">
          <label className="toolbar__label" htmlFor="control-search">
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
        </div>

        <div className="toolbar__field">
          <span className="toolbar__label" id="control-length-label">
            Length
          </span>
          <div aria-labelledby="control-length-label" className="range" role="group">
            <label className="visually-hidden" htmlFor="control-min">
              Shortest label length
            </label>
            {/* Described by its own message, so the value and the reason it is not
                filtering are announced together where the visitor is typing rather than
                only in a band further up the page. */}
            <input
              aria-describedby={min.advisory?.id}
              aria-invalid={min.advisory !== null}
              className="input input--bound mono"
              id="control-min"
              inputMode="numeric"
              max={MAX_LENGTH_BOUND}
              min={MIN_LENGTH_BOUND}
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
              aria-describedby={max.advisory?.id}
              aria-invalid={max.advisory !== null}
              className="input input--bound mono"
              id="control-max"
              inputMode="numeric"
              max={MAX_LENGTH_BOUND}
              min={MIN_LENGTH_BOUND}
              onChange={onBound('max')}
              placeholder="any"
              type="number"
              value={max.text}
            />
          </div>
        </div>

        {filtered && (
          <a className="toolbar__reset" href={resetHref}>
            Clear filters
          </a>
        )}
      </div>

      <details className="more">
        <summary className="more__summary">More filters</summary>

        <div className="more__body">
          <div className="more__grid">
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
                  {/* No `for` here: there is no control to label, and a label
                      pointing at nothing would be announced as an empty field. */}
                  <span className="field__label">Source list</span>
                  <p className="field__hint">
                    This snapshot does not say which list each name came from, so it cannot be
                    filtered by list. Reason:{' '}
                    {attribution.reason ?? 'attribution could not be verified'}.
                  </p>
                </>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="control-sort">
                Sort by
              </label>
              {/* The key and the direction are one decision, so they share a row. */}
              <div className="sort">
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
                    {DIRECTION_LABEL[query.sort][query.direction === 'asc' ? 'desc' : 'asc']}{' '}
                    instead.
                  </span>
                </button>
              </div>
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
          </fieldset>

          <div className="more__notes">
            <p className="field__hint" id="control-search-hint">
              Search matches anywhere in the label. Case is ignored and a trailing <code>.eth</code>{' '}
              is dropped. Length is counted in characters, without the <code>.eth</code> suffix.
            </p>
            <p className="field__hint">
              With no status ticked, every status in this view is shown. These are the statuses the
              scan recorded, not a fresh check.
            </p>
          </div>
        </div>
      </details>
    </section>
  )
}
