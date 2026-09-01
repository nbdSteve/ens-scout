import { useMemo, type ReactNode } from 'react'
import { Controls } from './components/Controls'
import { EmptyState } from './components/EmptyState'
import { ErrorState } from './components/ErrorState'
import { LoadingState } from './components/LoadingState'
import { Notice } from './components/Notice'
import { Pagination } from './components/Pagination'
import { ResultsTable } from './components/ResultsTable'
import { SimulatedClockNotice } from './components/SimulatedClockNotice'
import { SnapshotStatus } from './components/SnapshotStatus'
import { StaleWarning } from './components/StaleWarning'
import { SummaryCounts } from './components/SummaryCounts'
import { ViewTabs } from './components/ViewTabs'
import { appConfig, type AppConfig } from './config/env'
import { FIXTURE_DESCRIPTION } from './data/fixtures'
import type { Status } from './snapshot/contract'
import { deriveAttribution } from './snapshot/attribution'
import { applyQuery, countByStatus, filterResults } from './state/filter'
import { CLEAR_FILTERS, isFiltered } from './state/query'
import { useNow } from './state/useNow'
import { useSnapshot, type SnapshotDeps } from './state/useSnapshot'
import { useUrlState } from './state/useUrlState'
import { VIEWS, viewOrDefault } from './state/views'

/**
 * The page.
 *
 * The reading order is deliberate and is the same order a visitor needs the
 * information in: what this page is and what it is not, whether the clock is real,
 * whether the data is overdue, when it was scanned, what it found, how to narrow
 * it, and only then the names. Putting the caveats after the results would make
 * them decoration.
 */
export interface AppProps {
  /** Overridden in tests. Defaults to the build-time configuration. */
  readonly config?: AppConfig
  readonly deps?: SnapshotDeps
}

export function App({ config = appConfig, deps }: AppProps): ReactNode {
  const { query, warnings, setQuery, hrefFor } = useUrlState()
  const now = useNow(query.now)
  const store = useSnapshot(config, deps)

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
  // How many rows each view would show under the filters currently in force. The
  // view's own status preset is applied and any hand-picked statuses are dropped,
  // since those belong to the view they were picked in and do not carry across.
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
  const filtered = isFiltered(query)
  const resetHref = hrefFor(CLEAR_FILTERS)

  return (
    <>
      <a className="skip-link" href="#results">
        Skip to the names
      </a>
      <div className="page">
        <header className="masthead">
          <h1 className="masthead__title">ENS Scout</h1>
          <p className="masthead__lede">
            A published snapshot of candidate <code>.eth</code> names. Every status below is what
            the ENS subgraph reported at one recorded instant.
          </p>
          <Notice tone="info" title="This page is not the ENS registry">
            <p>
              The subgraph is an index, not the registration authority, and nothing here is checked
              again when you open the page. Confirm availability and price with{' '}
              <a href="https://app.ens.domains/">the ENS app</a> before registering anything.
            </p>
          </Notice>
        </header>

        <main className="stack" id="main">
          {query.now !== null && (
            <SimulatedClockNotice now={now} realHref={hrefFor({ now: null })} />
          )}

          {warnings.length > 0 && (
            <Notice alert tone="warn" title="Part of that link could not be applied">
              <ul className="notice__list">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          )}

          {config.apiBaseUrl === null && (
            <Notice tone="info" title="Local preview">
              <p>
                No read API is configured, so this page is showing the committed{' '}
                <code>{config.fixtureId}</code> fixture: {FIXTURE_DESCRIPTION[config.fixtureId]}
              </p>
            </Notice>
          )}

          {store.failure !== null && store.snapshot !== null && (
            <Notice alert tone="warn" title="Showing a stored copy">
              <p>
                The read API could not be reached, so this is the snapshot this browser stored on an
                earlier visit. It has not been refreshed. Reported reason:{' '}
                <span className="mono">{store.failure.message}</span>
              </p>
              <p>
                <button className="button" onClick={store.retry} type="button">
                  Try to refresh
                </button>
              </p>
            </Notice>
          )}

          {store.phase === 'loading' && <LoadingState />}

          {store.phase === 'failed' && store.failure !== null && (
            <ErrorState failure={store.failure} onRetry={store.retry} />
          )}

          {snapshot !== null && store.origin !== null && attribution !== null && page !== null && (
            <>
              <StaleWarning metadata={snapshot.metadata} now={now} />
              <SnapshotStatus
                cachedAt={store.cachedAt}
                confirmedCurrent={store.confirmedCurrent}
                now={now}
                origin={store.origin}
                snapshot={snapshot}
              />
              <SummaryCounts metadata={snapshot.metadata} />
              <ViewTabs
                counts={viewCounts}
                current={view.id}
                hrefForView={(id) => hrefFor({ view: id })}
              />
              <Controls
                attribution={attribution}
                query={query}
                resetHref={resetHref}
                setQuery={setQuery}
                sources={snapshot.metadata.sources}
                statusCounts={statusCounts}
                total={page.total}
              />
              <section aria-labelledby="results-heading" className="card results-card" id="results">
                <div>
                  <h2 className="card__title" id="results-heading">
                    {view.label}
                  </h2>
                  <p className="prose">{view.summary}</p>
                </div>
                {page.total === 0 ? (
                  <EmptyState filtered={filtered} resetHref={resetHref} viewLabel={view.label} />
                ) : (
                  <>
                    <ResultsTable
                      direction={query.direction}
                      now={now}
                      rows={page.rows}
                      sort={query.sort}
                    />
                    <Pagination
                      firstRow={page.firstRow}
                      hrefForPage={(n) => hrefFor({ page: n })}
                      lastRow={page.lastRow}
                      page={page.page}
                      pageCount={page.pageCount}
                      total={page.total}
                    />
                  </>
                )}
              </section>
            </>
          )}
        </main>

        <footer className="footer">
          <p>
            <strong>ENS decides, not this page.</strong> A name shown as available was available at
            the scan time recorded above, which is not the same as available now. Check{' '}
            <a href="https://app.ens.domains/">app.ens.domains</a> before you register.
          </p>
          <p>
            Grace and premium periods follow ENSv1 <code>.eth</code> rules: 90 days of grace after
            expiry, then 21 days of declining temporary premium. The scanner computes them; this
            page only displays what it published.
          </p>
        </footer>
      </div>
    </>
  )
}
