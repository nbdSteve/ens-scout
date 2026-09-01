import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { parseQuery, serializeQuery, updateQuery, type QueryState } from './query'

/**
 * Binds the query string to React.
 *
 * The URL is the single source of truth, not a mirror of component state: a
 * change is written to history and then read back out of the location. That makes
 * the back button work on every control for free, and makes the address bar
 * always hold a link that reproduces the screen. A copy in React state could
 * disagree with the address bar; this cannot.
 *
 * The location is an external store rather than state, which is what it actually
 * is - the browser owns it, and `popstate` is its change notification. Treating
 * it that way also means the one place that has to rewrite a non-canonical
 * incoming link does so by navigating, not by setting state during an effect.
 *
 * There is no router. One page with a handful of query parameters does not need
 * one, and `history.pushState` plus `popstate` is the whole mechanism a router
 * would wrap.
 */

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('popstate', onChange)
  }
}

function getSearch(): string {
  return window.location.search
}

function getServerSearch(): string {
  return ''
}

/**
 * Navigates within the page. `pushState` and `replaceState` do not fire
 * `popstate`, so subscribers are told directly.
 */
function navigate(search: string, replace: boolean): void {
  if (search === window.location.search) {
    return
  }
  const url = `${window.location.pathname}${search}`
  if (replace) {
    window.history.replaceState(null, '', url)
  } else {
    window.history.pushState(null, '', url)
  }
  notify()
}

export interface UrlState {
  readonly query: QueryState
  /** Parts of the incoming link that could not be applied. */
  readonly warnings: readonly string[]
  /** Applies a change, pushing a history entry unless `replace` is set. */
  readonly setQuery: (change: Partial<QueryState>, options?: { replace?: boolean }) => void
  /** A canonical link for a change, so controls that should be links can be links. */
  readonly hrefFor: (change: Partial<QueryState>) => string
}

export function useUrlState(): UrlState {
  const search = useSyncExternalStore(subscribe, getSearch, getServerSearch)
  const parsed = useMemo(() => parseQuery(search), [search])

  // An incoming link may be non-canonical: a parameter at its default, statuses
  // in an arbitrary order, a value that had to be dropped. Rewriting it once on
  // arrival - with replaceState, so the back button still leaves the site - keeps
  // the address bar holding a link that round-trips.
  const canonical = serializeQuery(parsed.state)
  useEffect(() => {
    navigate(canonical, true)
  }, [canonical])

  const setQuery = useCallback((change: Partial<QueryState>, options?: { replace?: boolean }) => {
    const next = serializeQuery(updateQuery(parseQuery(window.location.search).state, change))
    navigate(next, options?.replace === true)
  }, [])

  const hrefFor = useCallback(
    (change: Partial<QueryState>) => {
      const next = serializeQuery(updateQuery(parsed.state, change))
      return next === '' ? './' : next
    },
    [parsed.state],
  )

  return { query: parsed.state, warnings: parsed.warnings, setQuery, hrefFor }
}
