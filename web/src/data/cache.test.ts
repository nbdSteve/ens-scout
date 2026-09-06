import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION } from '../snapshot/contract'
import type { LatestDocument, SnapshotDocument } from '../snapshot/types'
import { buildLatestDocument, buildSnapshotDocument } from '../test/factory'
import { CACHE_KEY, clearCache, readCache, writeCache } from './cache'

/**
 * The cache key carries the wire version, so a version bump leaves the previous
 * entry unreadable and unreplaceable. These tests are about which keys survive:
 * the orphan has to go, and nothing else on the origin may go with it.
 */

/** A cache key from a wire format this build no longer reads. */
const OBSOLETE_KEY = `ens-scout.snapshot.v${String(FORMAT_VERSION - 1)}`

/** Keys that only share the prefix. Neither is one of these caches. */
const PROBE_KEY = `${CACHE_KEY}.probe`
const UNVERSIONED_KEY = 'ens-scout.snapshot.vNext'

/** An entry from another feature on the same origin. */
const UNRELATED_KEY = 'ens-scout.preferences'

/**
 * A `Storage` backed by a map. `refuse` rejects a write the way a full store
 * does, and sees the entries that are present, so a test can make room by
 * removing something and have the retry succeed.
 */
function memoryStorage(
  seed: Record<string, string> = {},
  refuse: (stored: ReadonlyMap<string, string>) => boolean = () => false,
): Storage {
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
      if (refuse(entries)) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      entries.set(key, value)
    },
  }
}

/** Every key the store holds, read the way the sweep reads them. */
function keysOf(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) {
      keys.push(key)
    }
  }
  return keys.sort()
}

function storedEntry(etag: string | null = '"abc"'): string {
  const snapshot = buildSnapshotDocument()
  return JSON.stringify({
    stored_at: '2026-03-01T13:00:00Z',
    etag,
    snapshot,
    latest: buildLatestDocument(snapshot),
  })
}

function freshEntry(): {
  snapshot: SnapshotDocument
  latest: LatestDocument | null
  etag: string | null
} {
  const snapshot = buildSnapshotDocument()
  return { snapshot, latest: buildLatestDocument(snapshot), etag: '"def"' }
}

describe('the local snapshot cache', () => {
  it('clears the caches of every wire format and nothing else', () => {
    const storage = memoryStorage({
      [CACHE_KEY]: storedEntry(),
      [OBSOLETE_KEY]: storedEntry(),
      [PROBE_KEY]: '1',
      [UNVERSIONED_KEY]: 'not a cache',
      [UNRELATED_KEY]: '{"view":"all"}',
    })

    clearCache(storage)

    expect(keysOf(storage)).toEqual([PROBE_KEY, UNVERSIONED_KEY, UNRELATED_KEY].sort())
  })

  it('drops an entry from an older wire format when a read rejects the current one', () => {
    const storage = memoryStorage({
      [CACHE_KEY]: '{"stored_at":"2026-03-01T13:00:00Z"}',
      [OBSOLETE_KEY]: storedEntry(),
      [UNRELATED_KEY]: '{"view":"all"}',
    })

    expect(readCache(storage)).toBeNull()
    expect(keysOf(storage)).toEqual([UNRELATED_KEY])
  })

  it('recovers from a full store by dropping the orphan rather than the fallback', () => {
    // The store has room for one entry: the write is refused while the orphan is
    // present and accepted once it is gone.
    const storage = memoryStorage(
      { [OBSOLETE_KEY]: storedEntry(), [UNRELATED_KEY]: 'kept' },
      (stored) => stored.has(OBSOLETE_KEY),
    )

    writeCache(storage, freshEntry(), new Date('2026-03-01T14:00:00Z'))

    expect(keysOf(storage)).toEqual([CACHE_KEY, UNRELATED_KEY].sort())
    expect(readCache(storage)?.etag).toBe('"def"')
  })

  it('keeps no stale copy when a full store cannot be recovered', () => {
    const storage = memoryStorage(
      { [CACHE_KEY]: storedEntry(), [OBSOLETE_KEY]: storedEntry(), [UNRELATED_KEY]: 'kept' },
      () => true,
    )

    writeCache(storage, freshEntry(), new Date('2026-03-01T14:00:00Z'))

    // Neither cache survives: one could not be replaced and the other is
    // unreadable by this build, so serving either would misreport this scan.
    expect(keysOf(storage)).toEqual([UNRELATED_KEY])
  })

  it('reclaims the orphan on the ordinary write, without waiting for a full store', () => {
    // This is the returning visitor: the previous version's entry is never read and
    // never replaced, so a write that succeeds is the moment it becomes provably
    // dead weight.
    const storage = memoryStorage({
      [OBSOLETE_KEY]: storedEntry(),
      [PROBE_KEY]: '1',
      [UNRELATED_KEY]: 'kept',
    })

    writeCache(storage, freshEntry(), new Date('2026-03-01T14:00:00Z'))

    expect(keysOf(storage)).toEqual([CACHE_KEY, PROBE_KEY, UNRELATED_KEY].sort())
    expect(readCache(storage)?.etag).toBe('"def"')
  })
})
