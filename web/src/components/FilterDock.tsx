import type { ReactNode } from 'react'
import type { Status } from '../snapshot/contract'
import type { Attribution } from '../snapshot/attribution'
import type { SourceList } from '../snapshot/types'
import type { LengthDrafts } from '../state/useLengthDrafts'
import type { QueryState } from '../state/query'
import { Toolbar } from './Toolbar'
import { ViewTabs } from './ViewTabs'

export interface FilterDockProps {
  readonly attribution: Attribution
  readonly currentView: string
  readonly hrefForView: (id: string) => string
  readonly lengthDrafts: LengthDrafts
  readonly query: QueryState
  readonly resetHref: string
  readonly setQuery: (change: Partial<QueryState>, options?: { replace?: boolean }) => void
  readonly sources: readonly SourceList[]
  readonly statusCounts: ReadonlyMap<Status, number>
  readonly viewCounts: ReadonlyMap<string, number>
}

export function FilterDock({
  attribution,
  currentView,
  hrefForView,
  lengthDrafts,
  query,
  resetHref,
  setQuery,
  sources,
  statusCounts,
  viewCounts,
}: FilterDockProps): ReactNode {
  return (
    <Toolbar
      attribution={attribution}
      lengthDrafts={lengthDrafts}
      query={query}
      resetHref={resetHref}
      setQuery={setQuery}
      sources={sources}
      statusCounts={statusCounts}
      views={<ViewTabs counts={viewCounts} current={currentView} hrefForView={hrefForView} />}
    />
  )
}
