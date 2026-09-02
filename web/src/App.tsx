import { useMemo, type ReactNode } from 'react'
import { EmptyState } from './components/EmptyState'
import { ErrorState } from './components/ErrorState'
import { LoadingState } from './components/LoadingState'
import { Notice } from './components/Notice'
import { Pagination } from './components/Pagination'
import { ResultsTable } from './components/ResultsTable'
import { SimulatedClockNotice } from './components/SimulatedClockNotice'
import { SnapshotDetails } from './components/SnapshotDetails'
import { StaleWarning } from './components/StaleWarning'
import { Toolbar } from './components/Toolbar'
import { TrustLine } from './components/TrustLine'
import { ViewTabs } from './components/ViewTabs'
import { appConfig, type AppConfig } from './config/env'
import { Optics } from './optics/Optics'
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
 * The names come first. A visitor arrives with one question - which names are open -
 * so the first screen is the answer to it: the view they are in, how many names it
 * holds, one line saying when the scan was taken and that these are recorded
 * statuses, the views, the two controls most likely to be used, and then rows.
 * Everything else is below them.
 *
 * That ordering is not a demotion of the caveats. The two that a reader must not be
 * able to miss are still above the list and still unmissable: the trust line always
 * states the scan time and that nothing here is a live check, and an overdue source
 * list raises a real alert. What moved below is the long form - the full provenance,
 * the per-list schedules, the published counts, the lifecycle rules, the method - and
 * it moved because at full length it filled the first screen and pushed the names
 * out of sight. A caveat nobody scrolls past the names to read is not a caveat.
 *
 * Anything that is both conditional and about trust stays in the advisories block
 * above the list: a simulated clock, a link that could not be applied in full, a
 * stored copy shown because the API could not be reached, an out-of-date list. Each
 * is rare, each changes how the rows below should be read, and none of them is
 * something to find later.
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
      {/*
       * First, and outside every other element. The optical layers blend against
       * the paper itself, so any wrapper between them and the body would isolate
       * them and flatten the whole background.
       */}
      <Optics />

      <a className="skip-link" href="#results">
        Skip to the names
      </a>

      {/*
       * Outside `.page` on purpose. The bar is full-bleed, so keeping it out of the
       * centred column means nothing inside that column is ever wider than it, and
       * it stays the page's only banner landmark.
       */}
      <header className="topbar">
        <div className="topbar__inner">
          <span className="wordmark">ENS Scout</span>
          <a
            className="topbar__link"
            href="https://app.ens.domains/"
            rel="noopener noreferrer"
            target="_blank"
          >
            Open the ENS app <span aria-hidden="true">&#8599;</span>
          </a>
        </div>
      </header>

      <main id="main">
        <div className="page">
          <div className="lede">
            {/*
             * The view names the page. It is also what the results region is
             * labelled by, so a screen reader that jumps straight to the table is
             * told which list it has landed in.
             */}
            <h1 className="lede__title" id="page-title">
              {view.title}
            </h1>
            {page !== null && (
              <p className="lede__count" role="status">
                {page.total.toLocaleString('en-GB')}{' '}
                {page.total === 1 ? 'name matches' : 'names match'}
              </p>
            )}
          </div>

          {snapshot !== null && <TrustLine now={now} snapshot={snapshot} />}

          <div className="advisories">
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

            {store.failure !== null && store.snapshot !== null && (
              <Notice alert tone="warn" title="Showing a stored copy">
                <p>
                  The read API could not be reached, so this is the snapshot this browser stored on
                  an earlier visit. It has not been refreshed. Reported reason:{' '}
                  <span className="mono">{store.failure.message}</span>
                </p>
                <p>
                  <button className="button" onClick={store.retry} type="button">
                    Try to refresh
                  </button>
                </p>
              </Notice>
            )}

            {snapshot !== null && <StaleWarning metadata={snapshot.metadata} now={now} />}
          </div>
        </div>

        {(store.phase === 'loading' || store.phase === 'failed') && (
          <div className="page">
            <div className="stack">
              {store.phase === 'loading' && <LoadingState />}
              {store.phase === 'failed' && store.failure !== null && (
                <ErrorState failure={store.failure} onRetry={store.retry} />
              )}
            </div>
          </div>
        )}

        {snapshot !== null && store.origin !== null && attribution !== null && page !== null && (
          <>
            {/*
             * The stage is full-bleed and carries its own dark palette, so the names
             * are read against nothing else. `.page` is repeated inside it rather
             * than the stage being stretched out of the column: a `100vw` block
             * includes the scrollbar and would make the document scroll sideways.
             */}
            <div className="stage">
              <div className="page">
                <ViewTabs
                  counts={viewCounts}
                  current={view.id}
                  hrefForView={(id) => hrefFor({ view: id })}
                />
                <Toolbar
                  attribution={attribution}
                  query={query}
                  resetHref={resetHref}
                  setQuery={setQuery}
                  sources={snapshot.metadata.sources}
                  statusCounts={statusCounts}
                />
                <section aria-labelledby="page-title" className="results-panel" id="results">
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
              </div>
            </div>

            <div className="page">
              <SnapshotDetails
                cachedAt={store.cachedAt}
                config={config}
                confirmedCurrent={store.confirmedCurrent}
                now={now}
                origin={store.origin}
                snapshot={snapshot}
              />
            </div>
          </>
        )}
      </main>

      <footer className="footer">
        <div className="page">
          <p>
            <strong>ENS decides, not this page.</strong> Every status here is what one scan
            recorded, not a live check. Confirm availability and price at{' '}
            <a href="https://app.ens.domains/">app.ens.domains</a> before you register.
          </p>
        </div>
      </footer>
    </>
  )
}
