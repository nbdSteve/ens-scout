import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { DataDrawer } from './components/DataDrawer'
import { DiscoveryHeader } from './components/DiscoveryHeader'
import { EmptyState } from './components/EmptyState'
import { ErrorState } from './components/ErrorState'
import { FilterDock } from './components/FilterDock'
import { LoadingState } from './components/LoadingState'
import { NameField } from './components/NameField'
import { Notice } from './components/Notice'
import { Pagination } from './components/Pagination'
import { SnapshotBadge } from './components/SnapshotBadge'
import { SnapshotDetails } from './components/SnapshotDetails'
import { StaleWarning } from './components/StaleWarning'
import { StoredCopyNotice } from './components/StoredCopyNotice'
import { SuggestPanel } from './components/SuggestPanel'
import { VerifyBar } from './components/VerifyBar'
import type { VerifyBinding } from './components/verification'
import { appConfig, type AppConfig } from './config/env'
import { formatAbsolute, toIsoSecond } from './format/time'
import type { Status } from './snapshot/contract'
import { deriveAttribution } from './snapshot/attribution'
import { resolveSourceGroups } from './snapshot/staleness'
import type { SnapshotResult } from './snapshot/types'
import { applyQuery, countByStatus, filterResults } from './state/filter'
import { CLEAR_FILTERS, isFiltered } from './state/query'
import { useFreshCheck, type FreshCheckDeps } from './state/useFreshCheck'
import { useLengthDrafts } from './state/useLengthDrafts'
import { useNow } from './state/useNow'
import { useSnapshot, type SnapshotDeps } from './state/useSnapshot'
import { useSuggest, type SuggestDeps } from './state/useSuggest'
import { useUrlState } from './state/useUrlState'
import { VIEWS, viewOrDefault } from './state/views'

export interface AppProps {
  readonly config?: AppConfig
  readonly deps?: SnapshotDeps
  readonly verifyDeps?: FreshCheckDeps
  readonly suggestDeps?: SuggestDeps
}

const NO_RESULTS: readonly SnapshotResult[] = []

const VIEW_HEADING: Readonly<Record<string, string>> = {
  available: 'Available',
  premium: 'Premium',
  expiring: 'Expiring',
  grace: 'Grace period',
  all: 'All scanned',
}

export function App({ config = appConfig, deps, verifyDeps, suggestDeps }: AppProps): ReactNode {
  const { query, warnings, setQuery, hrefFor } = useUrlState()
  const now = useNow(query.now)
  const store = useSnapshot(config, deps)
  const check = useFreshCheck(config, now, verifyDeps)
  const [dataOpen, setDataOpen] = useState(false)
  const dataReturnFocus = useRef<HTMLElement | null>(null)

  const snapshot = store.snapshot
  const attribution = useMemo(
    () =>
      snapshot === null ? null : deriveAttribution(snapshot.metadata.sources, snapshot.results),
    [snapshot],
  )
  const context = useMemo(
    () => ({ sourceIdByName: attribution?.available === true ? attribution.sourceIdByName : null }),
    [attribution],
  )
  const page = useMemo(
    () => (snapshot === null ? null : applyQuery(snapshot.results, query, context)),
    [snapshot, query, context],
  )
  const statusCounts = useMemo<ReadonlyMap<Status, number>>(
    () =>
      snapshot === null
        ? new Map<Status, number>()
        : countByStatus(snapshot.results, query, context),
    [snapshot, query, context],
  )
  const viewCounts = useMemo<ReadonlyMap<string, number>>(() => {
    const counts = new Map<string, number>()
    if (snapshot !== null) {
      for (const candidate of VIEWS) {
        counts.set(
          candidate.id,
          filterResults(snapshot.results, { ...query, view: candidate.id, statuses: [] }, context)
            .length,
        )
      }
    }
    return counts
  }, [snapshot, query, context])

  const view = viewOrDefault(query.view)
  const heading = VIEW_HEADING[view.id] ?? view.label
  const filtered = isFiltered(query)
  const resetHref = hrefFor(CLEAR_FILTERS)
  const lengthDrafts = useLengthDrafts(query.length)
  const notApplied = warnings.length + lengthDrafts.advisories.length

  const verify = useMemo<VerifyBinding | null>(
    () =>
      check.available
        ? {
            selected: check.selected,
            full: check.full,
            pending: check.pending,
            verified: check.verified,
            onToggle: check.toggle,
          }
        : null,
    [check.available, check.selected, check.full, check.pending, check.verified, check.toggle],
  )

  const interactive =
    snapshot !== null && store.origin !== null && attribution !== null && page !== null
  const suggest = useSuggest(
    { interactive, results: page?.matched ?? NO_RESULTS },
    suggestDeps ?? {},
  )

  const listProblem = useMemo<'unattributable' | 'unknown' | null>(() => {
    if (query.list === null || snapshot === null || attribution === null) {
      return null
    }
    if (!attribution.available) {
      return 'unattributable'
    }
    return snapshot.metadata.sources.some((source) => source.id === query.list) ? null : 'unknown'
  }, [query.list, snapshot, attribution])

  const hasStaleSource = useMemo(
    () =>
      snapshot !== null &&
      resolveSourceGroups(snapshot.metadata, now).some((group) => group.scanAge.isStale),
    [snapshot, now],
  )
  const hasDataNotice =
    query.now !== null ||
    notApplied > 0 ||
    listProblem !== null ||
    store.failure !== null ||
    hasStaleSource

  const openData = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
    dataReturnFocus.current = event.currentTarget
    setDataOpen(true)
  }, [])
  const closeData = useCallback((): void => {
    setDataOpen(false)
  }, [])

  useEffect(() => {
    document.title = view.title
  }, [view.title])

  return (
    <>
      <div className="site-shell">
        <a className="skip-link" href="#results">
          Skip to the names
        </a>

        <DiscoveryHeader dataOpen={dataOpen} hasNotice={hasDataNotice} onOpenData={openData} />

        <main id="main">
          {(store.phase === 'loading' || store.phase === 'failed') && (
            <div className="page load-state">
              {store.phase === 'loading' && <LoadingState />}
              {store.phase === 'failed' && store.failure !== null && (
                <ErrorState failure={store.failure} onRetry={store.retry} />
              )}
            </div>
          )}

          {snapshot !== null && store.origin !== null && attribution !== null && page !== null && (
            <>
              <div className="page discovery">
                <div className="editorial-heading">
                  <h1 id="page-title">
                    <span className="editorial-heading__word">{heading}</span>{' '}
                    <span className="editorial-heading__suffix">.eth names</span>
                  </h1>
                  <span className="editorial-heading__count" role="status">
                    {page.total.toLocaleString('en-GB')} {page.total === 1 ? 'name' : 'names'}
                  </span>
                </div>

                <FilterDock
                  attribution={attribution}
                  currentView={view.id}
                  hrefForView={(id) => hrefFor({ view: id })}
                  lengthDrafts={lengthDrafts}
                  query={query}
                  resetHref={resetHref}
                  setQuery={setQuery}
                  sources={snapshot.metadata.sources}
                  statusCounts={statusCounts}
                  viewCounts={viewCounts}
                />

                <SnapshotBadge
                  dataOpen={dataOpen}
                  now={now}
                  onOpenData={openData}
                  preview={query.now !== null}
                  snapshot={snapshot}
                />
              </div>

              <section aria-labelledby="page-title" className="spectrum" id="results">
                {check.available && (
                  <VerifyBar
                    checking={check.checking}
                    failure={check.failure}
                    onCheck={check.check}
                    onClear={check.clearSelection}
                    onDismiss={check.dismissFailure}
                    selected={check.selected}
                  />
                )}

                {page.total === 0 ? (
                  <EmptyState filtered={filtered} resetHref={resetHref} viewLabel={view.label} />
                ) : (
                  <>
                    <NameField
                      label={view.title}
                      now={now}
                      rows={page.rows}
                      showStatus={view.id !== 'available'}
                      transitionKey={view.id}
                      verify={verify}
                    />
                    <Pagination
                      firstRow={page.firstRow}
                      hrefForPage={(number) => hrefFor({ page: number })}
                      lastRow={page.lastRow}
                      page={page.page}
                      pageCount={page.pageCount}
                      total={page.total}
                    />
                  </>
                )}
              </section>

              <p aria-atomic="true" aria-live="polite" className="visually-hidden">
                {check.announcement}
              </p>
              <div aria-live="polite" className="visually-hidden">
                {warnings.map((warning) => (
                  <span key={warning}>{warning}</span>
                ))}
                {listProblem === 'unattributable' && (
                  <span>The requested source-list filter could not be applied.</span>
                )}
                {listProblem === 'unknown' && (
                  <span>The requested source list is not in this snapshot.</span>
                )}
              </div>

              <div className="page recommendations">
                <SuggestPanel
                  checking={check.checking}
                  now={now}
                  onCheck={check.check}
                  store={suggest}
                  verify={verify}
                />
              </div>
            </>
          )}
        </main>
      </div>

      <DataDrawer onClose={closeData} open={dataOpen} returnFocusRef={dataReturnFocus}>
        {query.now !== null && (
          <Notice tone="info" title="Preview clock">
            <p>
              Ages and countdowns use{' '}
              <time className="mono" dateTime={toIsoSecond(now)}>
                {formatAbsolute(now)}
              </time>
              .
            </p>
            <p>
              <a href={hrefFor({ now: null })}>Use the real time instead</a>
            </p>
          </Notice>
        )}

        {notApplied > 0 && (
          <Notice tone="warn" title="Not applied">
            <ul className="notice__list">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {lengthDrafts.advisories.map((advisory) => (
                <li key={advisory.end}>{advisory.text}</li>
              ))}
            </ul>
          </Notice>
        )}

        {listProblem === 'unattributable' && attribution !== null && (
          <Notice tone="warn" title="List filter not applied">
            <p>
              This snapshot cannot prove which names belong to{' '}
              <span className="mono">{query.list}</span>, so the full view is shown.
            </p>
            <p>
              <a href={hrefFor({ list: null })}>Show every list instead</a>
            </p>
          </Notice>
        )}

        {listProblem === 'unknown' && (
          <Notice tone="warn" title="Unknown list">
            <p>
              This snapshot has no list named <span className="mono">{query.list}</span>.
            </p>
            <p>
              <a href={hrefFor({ list: null })}>Show every list instead</a>
            </p>
          </Notice>
        )}

        {store.failure !== null && store.snapshot !== null && (
          <StoredCopyNotice failure={store.failure} onRetry={store.retry} />
        )}

        {snapshot !== null && <StaleWarning metadata={snapshot.metadata} now={now} />}

        {snapshot !== null && store.origin !== null && (
          <SnapshotDetails
            cachedAt={store.cachedAt}
            config={config}
            confirmedCurrent={store.confirmedCurrent}
            now={now}
            origin={store.origin}
            snapshot={snapshot}
          />
        )}
      </DataDrawer>
    </>
  )
}
