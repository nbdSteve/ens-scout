import { useCallback, useEffect, useState } from 'react'
import type { AppConfig } from '../config/env'
import { ApiError, fetchSnapshot } from '../data/api'
import { clearCache, getLocalStorage, readCache, writeCache } from '../data/cache'
import { loadFixture, type FixtureId, type FixturePayload } from '../data/fixtures'
import {
  assertPointerMatches,
  parseLatestDocument,
  parseSnapshotDocument,
  SnapshotFormatError,
  SnapshotVersionError,
  toSnapshot,
} from '../snapshot/parse'
import type { Snapshot } from '../snapshot/types'

/**
 * Loading one published snapshot.
 *
 * The interesting states here are not "loading" and "loaded". They are the ones
 * a visitor actually hits: an API that cannot be reached, a payload this build
 * does not understand, a locally cached scan from an earlier visit, and a server
 * that answers 304 to say the cached scan is still the current one. Each of those
 * is a distinct outcome the page has to be able to say out loud, so each is a
 * distinct field rather than a collapsed boolean.
 *
 * Two rules run through all of it. Nothing is ever shown without saying where it
 * came from and how old it is, and a payload that fails validation is never
 * repaired - it is refused, and the local copy that produced it is deleted so the
 * next load is not stuck on the same bytes.
 */

/** Where the snapshot on screen came from. Always shown to the visitor. */
export type SnapshotOrigin =
  /** A fixture built into this bundle, because no API is configured. */
  | 'fixture'
  /** The read API answered during this visit. */
  | 'network'
  /** The local copy of an earlier visit, because the API could not be reached. */
  | 'cache'

export type FailureKind =
  /** The payload is not a snapshot this build can read. */
  | 'malformed'
  /** The payload is a snapshot from a wire format this build does not know. */
  | 'version'
  /** The API could not be reached, or answered with an error. */
  | 'unavailable'

export interface LoadFailure {
  readonly kind: FailureKind
  readonly message: string
}

export interface SnapshotStore {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly snapshot: Snapshot | null
  readonly origin: SnapshotOrigin | null
  /** When the shown copy was stored locally. Null unless it came from the cache. */
  readonly cachedAt: Date | null
  /**
   * What went wrong. Set with `phase: 'failed'` when there is nothing to show,
   * and set alongside a snapshot when a cached copy is being served instead.
   */
  readonly failure: LoadFailure | null
  /** A request is in flight while an already-loaded snapshot stays on screen. */
  readonly revalidating: boolean
  /** The API confirmed during this visit that the shown snapshot is the current one. */
  readonly confirmedCurrent: boolean
  readonly retry: () => void
}

/** Injected for tests. Every field defaults to the real platform behaviour. */
export interface SnapshotDeps {
  readonly fetchImpl?: typeof fetch
  /** `undefined` probes `localStorage`; `null` disables caching outright. */
  readonly storage?: Storage | null
  readonly loadFixture?: (id: FixtureId) => Promise<FixturePayload>
  readonly now?: () => Date
}

interface State {
  readonly phase: SnapshotStore['phase']
  readonly snapshot: Snapshot | null
  readonly origin: SnapshotOrigin | null
  readonly cachedAt: Date | null
  readonly failure: LoadFailure | null
  readonly revalidating: boolean
  readonly confirmedCurrent: boolean
}

const LOADING: State = {
  phase: 'loading',
  snapshot: null,
  origin: null,
  cachedAt: null,
  failure: null,
  revalidating: false,
  confirmedCurrent: false,
}

/**
 * Turns a thrown value into something a visitor can act on. The distinction that
 * matters is whose problem it is: a version mismatch means this page is out of
 * date and reloading will fix it, a malformed payload means the data is wrong and
 * reloading will not, and an unreachable API means neither is broken.
 */
function describe(cause: unknown): LoadFailure {
  if (cause instanceof SnapshotVersionError) {
    return { kind: 'version', message: cause.message }
  }
  if (cause instanceof SnapshotFormatError) {
    return { kind: 'malformed', message: cause.message }
  }
  if (cause instanceof ApiError) {
    return { kind: 'unavailable', message: cause.message }
  }
  return { kind: 'unavailable', message: 'the snapshot could not be loaded' }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

interface CachedView {
  readonly snapshot: Snapshot
  readonly cachedAt: Date
  readonly etag: string | null
}

/**
 * The cached snapshot as something renderable, or null. `readCache` has already
 * re-validated the documents, so a failure here means the entry is unusable
 * regardless; it is deleted rather than kept to fail again next load.
 */
function readCachedView(storage: Storage | null): CachedView | null {
  const entry = readCache(storage)
  if (entry === null) {
    return null
  }
  try {
    return {
      snapshot: toSnapshot(entry.snapshot, entry.latest),
      cachedAt: entry.storedAt,
      etag: entry.etag,
    }
  } catch {
    clearCache(storage)
    return null
  }
}

/**
 * Loads the snapshot described by `config`.
 *
 * Each dependency is depended on individually rather than as one `deps` object, so
 * a caller passing an inline object literal does not restart the load on every
 * render. The overrides themselves are expected to be stable; the production path
 * passes none at all.
 */
export function useSnapshot(config: AppConfig, deps: SnapshotDeps = {}): SnapshotStore {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>(LOADING)

  const { apiBaseUrl, fixtureId } = config
  const { fetchImpl, storage: storageOverride, loadFixture: fixtureOverride, now } = deps

  useEffect(() => {
    const clock = now ?? ((): Date => new Date())
    const readFixture = fixtureOverride ?? loadFixture
    const controller = new AbortController()
    let live = true

    const settle = (next: State): void => {
      if (live) {
        setState(next)
      }
    }

    const loadFromFixture = async (): Promise<void> => {
      try {
        const payload = await readFixture(fixtureId)
        const document = parseSnapshotDocument(payload.snapshot)
        const pointer = payload.latest == null ? null : parseLatestDocument(payload.latest)
        if (pointer !== null) {
          assertPointerMatches(document, pointer)
        }
        settle({
          phase: 'ready',
          snapshot: toSnapshot(document, pointer),
          origin: 'fixture',
          cachedAt: null,
          failure: null,
          revalidating: false,
          // There is no publisher to ask, so nothing has been confirmed. A
          // fixture is labelled as a fixture instead.
          confirmedCurrent: false,
        })
      } catch (cause) {
        settle({ ...LOADING, phase: 'failed', failure: describe(cause) })
      }
    }

    const loadFromApi = async (baseUrl: string): Promise<void> => {
      // A `storage` of undefined means "use the platform", which is distinct from
      // an explicit null that turns caching off.
      const storage = storageOverride === undefined ? getLocalStorage() : storageOverride
      const cached = readCachedView(storage)
      if (cached !== null) {
        // Shown at once, labelled as the local copy, while the request runs. A
        // visitor on a slow connection reads last night's scan instead of a
        // spinner, and is told that is what they are reading.
        settle({
          phase: 'ready',
          snapshot: cached.snapshot,
          origin: 'cache',
          cachedAt: cached.cachedAt,
          failure: null,
          revalidating: true,
          confirmedCurrent: false,
        })
      }

      try {
        const outcome = await fetchSnapshot({
          baseUrl,
          etag: cached?.etag ?? null,
          signal: controller.signal,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })

        if (outcome.kind === 'not-modified') {
          if (cached === null) {
            // A 304 with nothing cached leaves the page with no snapshot at all.
            // The server answered a question this client did not ask, so the
            // honest outcome is a failure rather than an empty page.
            settle({
              ...LOADING,
              phase: 'failed',
              failure: {
                kind: 'unavailable',
                message: 'the read API reported no change, but this browser has no stored snapshot',
              },
            })
            return
          }
          settle({
            phase: 'ready',
            snapshot: cached.snapshot,
            origin: 'network',
            cachedAt: cached.cachedAt,
            failure: null,
            revalidating: false,
            confirmedCurrent: true,
          })
          return
        }

        writeCache(storage, outcome, clock())
        settle({
          phase: 'ready',
          snapshot: toSnapshot(outcome.snapshot, outcome.latest),
          origin: 'network',
          cachedAt: null,
          failure: null,
          revalidating: false,
          confirmedCurrent: true,
        })
      } catch (cause) {
        if (isAbort(cause)) {
          return
        }
        const failure = describe(cause)
        if (cached !== null) {
          // The offline case: keep serving the local copy, and say why it is not
          // being refreshed. Discarding readable data because the network failed
          // would be the worse answer.
          settle({
            phase: 'ready',
            snapshot: cached.snapshot,
            origin: 'cache',
            cachedAt: cached.cachedAt,
            failure,
            revalidating: false,
            confirmedCurrent: false,
          })
          return
        }
        settle({ ...LOADING, phase: 'failed', failure })
      }
    }

    void (apiBaseUrl === null ? loadFromFixture() : loadFromApi(apiBaseUrl))

    return () => {
      live = false
      controller.abort()
    }
  }, [apiBaseUrl, fixtureId, attempt, fetchImpl, storageOverride, fixtureOverride, now])

  const retry = useCallback(() => {
    setState((prev) =>
      prev.snapshot === null
        ? LOADING
        : { ...prev, phase: 'ready', failure: null, revalidating: true },
    )
    setAttempt((n) => n + 1)
  }, [])

  return { ...state, retry }
}
