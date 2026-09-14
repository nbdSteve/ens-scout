import { useCallback, useEffect, useRef, type ChangeEvent, type ReactNode } from 'react'
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

export interface ToolbarProps {
  readonly query: QueryState
  readonly setQuery: (change: Partial<QueryState>, options?: { replace?: boolean }) => void
  readonly statusCounts: ReadonlyMap<Status, number>
  readonly sources: readonly SourceList[]
  readonly attribution: Attribution
  readonly resetHref: string
  readonly lengthDrafts: LengthDrafts
  readonly views?: ReactNode
}

const DIRECTION_LABEL: Readonly<Record<SortId, { asc: string; desc: string }>> = {
  name: { asc: 'A to Z', desc: 'Z to A' },
  expiry: { asc: 'Soonest first', desc: 'Latest first' },
  'grace-end': { asc: 'Soonest first', desc: 'Latest first' },
  'premium-end': { asc: 'Soonest first', desc: 'Latest first' },
}

function rangeLabel(query: QueryState): string {
  const { min, max } = query.length
  if (min === null && max === null) {
    return 'Length'
  }
  if (min !== null && max !== null) {
    return `${String(min)}–${String(max)}`
  }
  return min === null ? `≤ ${String(max)}` : `≥ ${String(min)}`
}

export function Toolbar({
  query,
  setQuery,
  statusCounts,
  sources,
  attribution,
  resetHref,
  lengthDrafts,
  views,
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
      const bound = readLengthBound(typed.trim())
      if (end === 'min') {
        min.setText(typed, boundText(bound))
        setQuery({ length: { ...query.length, min: bound } }, { replace: true })
        return
      }
      max.setText(typed, boundText(bound))
      setQuery({ length: { ...query.length, max: bound } }, { replace: true })
    }

  const minBox = useRef<HTMLInputElement>(null)
  const maxBox = useRef<HTMLInputElement>(null)
  const noteMin = min.setUnreadable
  const noteMax = max.setUnreadable

  const readValidity = useCallback(() => {
    if (minBox.current !== null) {
      noteMin(minBox.current.validity.badInput)
    }
    if (maxBox.current !== null) {
      noteMax(maxBox.current.validity.badInput)
    }
  }, [noteMin, noteMax])

  useEffect(() => {
    const watched: readonly (readonly [HTMLInputElement | null, (bad: boolean) => void])[] = [
      [minBox.current, noteMin],
      [maxBox.current, noteMax],
    ]
    const stop = watched.map(([node, note]) => {
      if (node === null) {
        return () => undefined
      }
      const onInput = (): void => {
        note(node.validity.badInput)
      }
      node.addEventListener('input', onInput)
      return () => {
        node.removeEventListener('input', onInput)
      }
    })
    return () => {
      for (const off of stop) {
        off()
      }
    }
  }, [noteMin, noteMax])

  useEffect(readValidity, [readValidity, min.text, max.text])

  const onStatus = (status: Status, checked: boolean): void => {
    const next = checked
      ? STATUSES.filter((candidate) => candidate === status || query.statuses.includes(candidate))
      : query.statuses.filter((candidate) => candidate !== status)
    setQuery({ statuses: next })
  }

  return (
    <section aria-labelledby="toolbar-heading" className="toolbar">
      <h2 className="visually-hidden" id="toolbar-heading">
        Filter names
      </h2>

      <div className="toolbar__primary">
        <label className="toolbar__search" htmlFor="control-search">
          <span aria-hidden="true" className="toolbar__search-icon">
            ⌕
          </span>
          <span className="visually-hidden">Search names</span>
          <input
            aria-label="Search names"
            aria-describedby="control-search-hint"
            autoComplete="off"
            id="control-search"
            inputMode="search"
            onChange={onSearch}
            placeholder="Search .eth"
            spellCheck={false}
            type="search"
            value={search.text}
          />
        </label>

        <div className="toolbar__views">{views}</div>

        <div className="toolbar__utility">
          <details className="dock-popover dock-popover--length">
            <summary className="dock-button">{rangeLabel(query)}</summary>
            <div className="dock-popover__panel dock-popover__panel--length">
              <div className="range">
                <label className="field" htmlFor="control-min">
                  <span className="field__label">Shortest</span>
                  <input
                    aria-label="Shortest label length"
                    aria-describedby={min.advisory?.id}
                    aria-invalid={min.advisory !== null}
                    className="input input--bound mono"
                    id="control-min"
                    inputMode="numeric"
                    max={MAX_LENGTH_BOUND}
                    min={MIN_LENGTH_BOUND}
                    onChange={onBound('min')}
                    placeholder="Any"
                    ref={minBox}
                    type="number"
                    value={min.text}
                  />
                </label>
                <span aria-hidden="true" className="range__to">
                  —
                </span>
                <label className="field" htmlFor="control-max">
                  <span className="field__label">Longest</span>
                  <input
                    aria-label="Longest label length"
                    aria-describedby={max.advisory?.id}
                    aria-invalid={max.advisory !== null}
                    className="input input--bound mono"
                    id="control-max"
                    inputMode="numeric"
                    max={MAX_LENGTH_BOUND}
                    min={MIN_LENGTH_BOUND}
                    onChange={onBound('max')}
                    placeholder="Any"
                    ref={maxBox}
                    type="number"
                    value={max.text}
                  />
                </label>
              </div>
            </div>
          </details>

          <details className="dock-popover dock-popover--more">
            <summary className="dock-button">More</summary>
            <div className="dock-popover__panel dock-popover__panel--more">
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
                          setQuery({
                            list: event.target.value === '' ? null : event.target.value,
                          })
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
                      <span className="field__label">Source list</span>
                      <p className="field__hint">
                        This snapshot cannot attribute each name to a source list:{' '}
                        {attribution.reason}.
                      </p>
                    </>
                  )}
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="control-sort">
                    Sort by
                  </label>
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
                      aria-label={`${DIRECTION_LABEL[query.sort][query.direction]}. Press to sort ${
                        query.direction === 'asc'
                          ? DIRECTION_LABEL[query.sort].desc
                          : DIRECTION_LABEL[query.sort].asc
                      }`}
                      className="button button--quiet"
                      onClick={() => {
                        setQuery({
                          direction: query.direction === 'asc' ? 'desc' : 'asc',
                        })
                      }}
                      type="button"
                    >
                      {DIRECTION_LABEL[query.sort][query.direction]}
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

              {isFiltered(query) && (
                <a className="toolbar__reset" href={resetHref}>
                  Clear filters
                </a>
              )}
            </div>
          </details>
        </div>
      </div>

      <span className="visually-hidden" id="control-search-hint">
        Search matches anywhere in the label. Case is ignored and a trailing .eth is dropped.
      </span>
      <div aria-live="polite" className="visually-hidden">
        {lengthDrafts.advisories.map((advisory) => (
          <span id={advisory.id} key={advisory.end}>
            {advisory.text}
          </span>
        ))}
      </div>
    </section>
  )
}
