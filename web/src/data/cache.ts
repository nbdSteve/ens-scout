import { FORMAT_VERSION } from '../snapshot/contract'
import {
  assertPointerMatches,
  parseLatestDocument,
  parseSnapshotDocument,
  SnapshotFormatError,
} from '../snapshot/parse'
import type { LatestDocument, SnapshotDocument } from '../snapshot/types'

/**
 * The last valid snapshot, kept locally so a visitor who returns offline still
 * sees data instead of an error page.
 *
 * Two rules keep this from becoming a way to serve rubbish. Only a snapshot that
 * has already passed the full parser is ever written, and anything read back is
 * parsed again before it is used - a partially written entry, a hand-edited
 * entry, or an entry from an older format version is deleted rather than
 * repaired. And exactly one snapshot is kept: this is an offline fallback, not a
 * history, and a visitor who is shown an old scan is told which one it is and how
 * old it is.
 */

/** The cache key without its version. Every version's key begins with this. */
const CACHE_KEY_PREFIX = 'ens-scout.snapshot.v'

/**
 * The format version is part of the key, so a `FormatVersion` bump cannot
 * resurrect bytes written by a build that read a different wire format.
 */
export const CACHE_KEY = `${CACHE_KEY_PREFIX}${String(FORMAT_VERSION)}`

/**
 * Whether a key is one of these caches, from any wire version. It is built from
 * the same prefix the key itself is, so the two cannot drift apart, and the tail
 * has to be a version number and nothing else: the probe key and any other
 * `ens-scout.snapshot.*` entry is not one of these and is left alone.
 */
function isCacheKey(key: string): boolean {
  if (!key.startsWith(CACHE_KEY_PREFIX)) {
    return false
  }
  return /^\d+$/.test(key.slice(CACHE_KEY_PREFIX.length))
}

/**
 * Drops the caches written by a build that read a different wire format.
 *
 * A version bump changes the key, so those bytes are never read and never
 * replaced: one snapshot-sized entry would sit in the origin's quota forever, and
 * a current write that then hit the quota would give up the offline fallback to
 * make room for nothing. Only keys of this exact shape are touched, and only the
 * ones naming another version, so an unrelated entry from the same origin is
 * never collateral.
 *
 * The keys are collected before any is removed, because removing during iteration
 * reindexes the store and would skip the entry after each removal.
 */
function clearObsoleteCaches(storage: Storage): void {
  try {
    const obsolete: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || key === CACHE_KEY || !isCacheKey(key)) {
        continue
      }
      obsolete.push(key)
    }
    for (const key of obsolete) {
      storage.removeItem(key)
    }
  } catch {
    // A store that will not enumerate or will not remove keeps its orphan. That
    // costs space and nothing else, so it never affects the current entry.
  }
}

/** Writes the current entry, reporting whether the store accepted it. */
function storeEntry(storage: Storage, serialized: string): boolean {
  try {
    storage.setItem(CACHE_KEY, serialized)
    return true
  } catch {
    return false
  }
}

export interface CacheEntry {
  readonly snapshot: SnapshotDocument
  readonly latest: LatestDocument | null
  /** The ETag the snapshot was served with, for `If-None-Match` next time. */
  readonly etag: string | null
  /** When this copy was stored locally. Distinct from when the scan happened. */
  readonly storedAt: Date
}

interface StoredShape {
  readonly stored_at: string
  readonly etag: string | null
  readonly snapshot: unknown
  readonly latest: unknown
}

/**
 * `localStorage` is unavailable in some privacy modes and throws on access
 * rather than returning null, so every use is guarded. Losing the cache degrades
 * the site to online-only; it is never a reason to fail a page load.
 */
export function getLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage
    // Some environments expose the object but reject every operation.
    const probe = `${CACHE_KEY}.probe`
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}

/**
 * Removes this build's cache, and any left behind by an older wire format along
 * with it. Clearing is the one moment the whole family is known to be disposable,
 * so it is where the orphans go.
 */
export function clearCache(storage: Storage | null): void {
  if (storage === null) {
    return
  }
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // A cache that cannot be cleared is still a cache that will be re-validated.
  }
  clearObsoleteCaches(storage)
}

/**
 * Reads the cached snapshot, or null when there is none worth trusting. A
 * malformed or outdated entry is removed on the way out, so a visitor is not
 * stuck with bytes that will fail again on every load.
 */
export function readCache(storage: Storage | null): CacheEntry | null {
  if (storage === null) {
    return null
  }
  let raw: string | null
  try {
    raw = storage.getItem(CACHE_KEY)
  } catch {
    return null
  }
  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SnapshotFormatError('cached entry is not an object')
    }
    const stored = parsed as Partial<StoredShape>
    if (typeof stored.stored_at !== 'string') {
      throw new SnapshotFormatError('cached entry has no store time')
    }
    const storedAt = new Date(stored.stored_at)
    if (Number.isNaN(storedAt.getTime())) {
      throw new SnapshotFormatError('cached entry has an unreadable store time')
    }
    const snapshot = parseSnapshotDocument(stored.snapshot)
    const latest = stored.latest == null ? null : parseLatestDocument(stored.latest)
    if (latest !== null) {
      assertPointerMatches(snapshot, latest)
    }
    return {
      snapshot,
      latest,
      etag: typeof stored.etag === 'string' ? stored.etag : null,
      storedAt,
    }
  } catch {
    clearCache(storage)
    return null
  }
}

/**
 * Replaces the cached snapshot. The caller must already have validated the
 * documents; the local copy is only ever as good as what was accepted from the
 * network.
 */
export function writeCache(
  storage: Storage | null,
  entry: { snapshot: SnapshotDocument; latest: LatestDocument | null; etag: string | null },
  storedAt: Date,
): void {
  if (storage === null) {
    return
  }
  const payload: StoredShape = {
    stored_at: storedAt.toISOString(),
    etag: entry.etag,
    snapshot: entry.snapshot,
    latest: entry.latest,
  }
  const serialized = JSON.stringify(payload)
  if (storeEntry(storage, serialized)) {
    // The write proves this build's key is the only one it reads, so a cache under
    // any other version is now unreachable: nothing will read it and nothing will
    // replace it. Reclaiming its space is not conditional on the store being full.
    clearObsoleteCaches(storage)
    return
  }
  // A full store may be full of exactly that, so make the room and try once more
  // rather than give up the offline fallback to bytes nothing will ever serve.
  clearObsoleteCaches(storage)
  if (storeEntry(storage, serialized)) {
    return
  }
  // A full or read-only store means no offline fallback, nothing worse. The stale
  // entry that could not be replaced is dropped so it cannot be served as if it
  // were this scan.
  clearCache(storage)
}
