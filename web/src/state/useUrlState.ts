import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  describeQueryState,
  parseQuery,
  serializeQuery,
  updateQuery,
  type QueryState,
} from './query'

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

/**
 * The link the screen was reached by, as parsed before it was canonicalized.
 * `canonical` is `null` when there is nothing to say, which is a state no link can be
 * equal to.
 */
interface Arrival {
  readonly canonical: string | null
  readonly warnings: readonly string[]
}

/** One shared value, so a repeated discard is `Object.is`-equal and re-renders nothing. */
const NOTHING_TO_SAY: Arrival = { canonical: null, warnings: [] }

/** What could not be applied about a link, or `NOTHING_TO_SAY` when all of it could. */
function outcomeOf(search: string): Arrival {
  const parsed = parseQuery(search)
  return parsed.warnings.length === 0
    ? NOTHING_TO_SAY
    : { canonical: serializeQuery(parsed.state), warnings: parsed.warnings }
}

export interface UrlState {
  readonly query: QueryState
  /** Parts of the current link that could not be applied, whether it was followed or made here. */
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

  // Some warnings describe the link the screen was reached by, and the rewrite above
  // erases the evidence for them: re-parsing the canonical link produces none, because
  // whatever could not be applied is no longer in it. Read straight from the current
  // location, that notice would appear for one render and then vanish, which is the
  // same as never showing it. So the outcome is captured once, before anything has been
  // rewritten, and its warnings are shown for as long as the screen they describe is
  // the screen on display.
  const [arrival, setArrival] = useState<Arrival>(() => outcomeOf(window.location.search))
  // And the rest describe the state, which the rewrite keeps. Those are re-derived from
  // whatever the location now holds, because the capture above is one-shot and only
  // `setQuery` refreshes it: `popstate` does not, so a back or forward navigation would
  // otherwise land on a screen still holding an inverted range with nothing saying it
  // is not being applied.
  const stateWarnings = useMemo(() => describeQueryState(parsed.state), [parsed.state])
  const warnings = arrival.canonical === canonical ? arrival.warnings : stateWarnings

  const setQuery = useCallback((change: Partial<QueryState>, options?: { replace?: boolean }) => {
    const next = serializeQuery(updateQuery(parseQuery(window.location.search).state, change))
    // A change the visitor makes is captured the same way an incoming link is, because
    // it can be unusable in exactly the same ways: typing a shortest length above the
    // current longest one writes a range the sanitiser drops, and it must not be
    // dropped in silence. Recapturing is also what retires the previous notice, which
    // the comparison above cannot do on its own - clearing a filter can land back on
    // the earlier link, and a notice about it must not return once the visitor has been
    // somewhere else. This is the only in-page navigation; every other control is a
    // real `<a href="?...">`, which loads the document again and captures the new link
    // on the way.
    setArrival(outcomeOf(next))
    navigate(next, options?.replace === true)
  }, [])

  const hrefFor = useCallback(
    (change: Partial<QueryState>) => {
      const next = serializeQuery(updateQuery(parsed.state, change))
      return next === '' ? './' : next
    },
    [parsed.state],
  )

  return { query: parsed.state, warnings, setQuery, hrefFor }
}
