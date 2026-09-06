import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config/env'
import { CACHE_KEY } from '../data/cache'
import { buildLatestDocument, buildSnapshotDocument } from '../test/factory'
import { useSnapshot, type SnapshotDeps } from './useSnapshot'

/**
 * The loader is tested through its outcomes rather than its internals, because the
 * outcomes are what the page says out loud: where the data came from, how old it
 * is, and whether anything failed.
 */

const FIXTURE_CONFIG: AppConfig = { apiBaseUrl: null, fixtureId: 'preview' }
const API_CONFIG: AppConfig = { apiBaseUrl: 'https://read.example', fixtureId: 'preview' }

/** A `Storage` backed by a map, so a test can seed and inspect the cache. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map<string, string>(Object.entries(seed))
  return {
    get length() {
      return entries.size
    },
    clear: () => {
      entries.clear()
    },
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key)
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

function cacheEntry(etag: string | null, storedAt = '2026-03-01T13:00:00Z'): string {
  const snapshot = buildSnapshotDocument()
  return JSON.stringify({
    stored_at: storedAt,
    etag,
    snapshot,
    latest: buildLatestDocument(snapshot),
  })
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Answers the snapshot route and the pointer route from one map of handlers. */
function routedFetch(handlers: {
  snapshot: (request: Request) => Response
  latest?: (request: Request) => Response
}): typeof fetch {
  return (input, init) => {
    // Rebuilt as a `Request` so a handler can read the headers the loader sent,
    // whichever of the three input forms the caller used.
    const request = new Request(input, init)
    if (request.url.endsWith('/api/latest')) {
      return Promise.resolve(
        handlers.latest === undefined
          ? new Response(null, { status: 404 })
          : handlers.latest(request),
      )
    }
    return Promise.resolve(handlers.snapshot(request))
  }
}

function render(config: AppConfig, deps: SnapshotDeps) {
  return renderHook(() => useSnapshot(config, deps))
}

describe('useSnapshot in fixture mode', () => {
  it('serves a valid fixture and says it is a fixture', async () => {
    const snapshot = buildSnapshotDocument()
    const { result } = render(FIXTURE_CONFIG, {
      loadFixture: () => Promise.resolve({ snapshot, latest: buildLatestDocument(snapshot) }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('ready')
    })
    expect(result.current.origin).toBe('fixture')
    expect(result.current.snapshot?.metadata.names).toBe(4)
    // Nothing confirmed it: there is no publisher to ask.
    expect(result.current.confirmedCurrent).toBe(false)
    expect(result.current.failure).toBeNull()
  })

  it('refuses a malformed fixture rather than showing part of it', async () => {
    const { result } = render(FIXTURE_CONFIG, {
      loadFixture: () => Promise.resolve({ snapshot: { metadata: {} }, latest: null }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('failed')
    })
    expect(result.current.failure?.kind).toBe('malformed')
    expect(result.current.snapshot).toBeNull()
  })

  it('reports an unknown wire version separately, because reloading fixes that one', async () => {
    const snapshot = { ...buildSnapshotDocument() }
    const { result } = render(FIXTURE_CONFIG, {
      loadFixture: () =>
        Promise.resolve({
          snapshot: { ...snapshot, metadata: { ...snapshot.metadata, format_version: 99 } },
          latest: null,
        }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('failed')
    })
    expect(result.current.failure?.kind).toBe('version')
  })

  it('refuses a pointer that names a different scan', async () => {
    const snapshot = buildSnapshotDocument()
    const pointer = { ...buildLatestDocument(snapshot), snapshot_id: 'other-snapshot' }
    const { result } = render(FIXTURE_CONFIG, {
      loadFixture: () => Promise.resolve({ snapshot, latest: pointer }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('failed')
    })
    expect(result.current.failure?.kind).toBe('malformed')
  })
})

describe('useSnapshot against a read API', () => {
  it('stores what it fetched, so the next visit has a fallback', async () => {
    const snapshot = buildSnapshotDocument()
    const storage = memoryStorage()
    const { result } = render(API_CONFIG, {
      storage,
      now: () => new Date('2026-03-01T14:00:00Z'),
      fetchImpl: routedFetch({
        snapshot: () => jsonResponse(snapshot, { etag: '"abc"' }),
        latest: () => jsonResponse(buildLatestDocument(snapshot)),
      }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('ready')
    })
    expect(result.current.origin).toBe('network')
    expect(result.current.confirmedCurrent).toBe(true)
    const stored: unknown = JSON.parse(storage.getItem(CACHE_KEY) ?? 'null')
    expect(stored).toMatchObject({ etag: '"abc"', stored_at: '2026-03-01T14:00:00.000Z' })
  })

  it('revalidates with the stored ETag and keeps the stored snapshot on 304', async () => {
    const storage = memoryStorage({ [CACHE_KEY]: cacheEntry('"abc"') })
    const seen: (string | null)[] = []
    const { result } = render(API_CONFIG, {
      storage,
      fetchImpl: routedFetch({
        snapshot: (request) => {
          seen.push(request.headers.get('if-none-match'))
          return new Response(null, { status: 304 })
        },
      }),
    })

    await waitFor(() => {
      expect(result.current.confirmedCurrent).toBe(true)
    })
    expect(seen).toEqual(['"abc"'])
    expect(result.current.phase).toBe('ready')
    // Confirmed current, so it is the API's answer even though the bytes are local.
    expect(result.current.origin).toBe('network')
    expect(result.current.snapshot?.metadata.snapshotId).toBe('test-snapshot')
    expect(result.current.cachedAt).toEqual(new Date('2026-03-01T13:00:00Z'))
  })

  it('fails closed on a 304 with nothing stored', async () => {
    const { result } = render(API_CONFIG, {
      storage: memoryStorage(),
      fetchImpl: routedFetch({ snapshot: () => new Response(null, { status: 304 }) }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('failed')
    })
    expect(result.current.failure?.kind).toBe('unavailable')
  })

  it('serves the stored snapshot when the API cannot be reached, and says so', async () => {
    const storage = memoryStorage({ [CACHE_KEY]: cacheEntry('"abc"') })
    const { result } = render(API_CONFIG, {
      storage,
      fetchImpl: () => Promise.reject(new TypeError('offline')),
    })

    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    expect(result.current.phase).toBe('ready')
    expect(result.current.origin).toBe('cache')
    expect(result.current.confirmedCurrent).toBe(false)
    expect(result.current.snapshot?.metadata.names).toBe(4)
  })

  it('keeps the stored snapshot when the API answers with one it cannot resolve', async () => {
    /*
     * The scan time is the wrong shape - a space where the publisher writes `T` - and
     * no pointer route answers, so nothing else forces that string through a check.
     * The local copy is a visitor's offline fallback: replacing it with a payload the
     * page cannot render would leave the next offline visit on the error page instead
     * of on the scan they already had.
     */
    const good = cacheEntry('"abc"')
    const storage = memoryStorage({ [CACHE_KEY]: good })
    const document = buildSnapshotDocument()
    const { result } = render(API_CONFIG, {
      storage,
      fetchImpl: routedFetch({
        snapshot: () =>
          jsonResponse({
            ...document,
            metadata: { ...document.metadata, scanned_at: '2026-03-01 12:00:00' },
          }),
      }),
    })

    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    expect(result.current.failure?.kind).toBe('malformed')
    expect(result.current.origin).toBe('cache')
    expect(storage.getItem(CACHE_KEY)).toBe(good)
  })

  it('deletes a stored entry this build cannot read', async () => {
    const storage = memoryStorage({ [CACHE_KEY]: '{"stored_at":"2026-03-01T13:00:00Z"}' })
    const snapshot = buildSnapshotDocument()
    const { result } = render(API_CONFIG, {
      storage,
      fetchImpl: routedFetch({ snapshot: () => jsonResponse(snapshot) }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('ready')
    })
    expect(result.current.origin).toBe('network')
    expect(storage.getItem(CACHE_KEY)).not.toBe('{"stored_at":"2026-03-01T13:00:00Z"}')
  })

  it('recovers on retry after a failure', async () => {
    const snapshot = buildSnapshotDocument()
    let online = false
    const { result } = render(API_CONFIG, {
      storage: memoryStorage(),
      fetchImpl: routedFetch({
        snapshot: () => (online ? jsonResponse(snapshot) : new Response('nope', { status: 503 })),
      }),
    })

    await waitFor(() => {
      expect(result.current.phase).toBe('failed')
    })

    online = true
    result.current.retry()

    await waitFor(() => {
      expect(result.current.phase).toBe('ready')
    })
    expect(result.current.failure).toBeNull()
    expect(result.current.origin).toBe('network')
  })
})
