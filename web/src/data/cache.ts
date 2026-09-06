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

/**
 * The format version is part of the key, so a `FormatVersion` bump cannot
 * resurrect bytes written by a build that read a different wire format.
 */
export const CACHE_KEY = `ens-scout.snapshot.v${String(FORMAT_VERSION)}`

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

export function clearCache(storage: Storage | null): void {
  if (storage === null) {
    return
  }
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // A cache that cannot be cleared is still a cache that will be re-validated.
  }
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
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    // A full or read-only store means no offline fallback, nothing worse. The
    // stale entry that could not be replaced is dropped so it cannot be served
    // as if it were this scan.
    clearCache(storage)
  }
}
