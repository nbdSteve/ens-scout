import { OPT_OUT_KEY, OPT_OUT_KEY_PREFIX } from './contract'

/**
 * Remembering that a visitor said no.
 *
 * A visitor who turns the model off has to stay turned off. A two-hundred-megabyte
 * download that comes back on the next page load is not an opt-out, it is a delay, so
 * this is the smallest durable thing that could record the decision: one key, present or
 * absent.
 *
 * A marker rather than a value, deliberately. There is no stored shape to misread, no
 * parse to fail, and therefore no case where a corrupt entry has to be interpreted one
 * way or the other - the key existing is the whole statement, and removing it is the
 * whole reversal. Whatever it holds is ignored.
 *
 * It is versioned like the snapshot cache key in `data/cache.ts`, for the same reason: if
 * this ever needs to hold more than a marker, the previous key would be read by nothing
 * and replaced by nothing. `sweepObsolete` drops the ones this build does not use, so an
 * older version's marker cannot go on suppressing a feature through a key nothing reads.
 *
 * Nothing here is shared with a server, and nothing about the visitor's preference leaves
 * the device. It is a local marker on this origin, which is the only place it means
 * anything.
 */

/** Injected so a test can supply a store, including one that throws on every call. */
export interface OptOutStore {
  readonly read: () => boolean
  readonly set: (optedOut: boolean) => void
}

/**
 * Whether a key is one of these markers, from any version. Built from the same prefix the
 * key itself is, and the tail has to be a version number and nothing else, so no other
 * entry on the origin is ever collateral.
 */
function isOptOutKey(key: string): boolean {
  if (!key.startsWith(OPT_OUT_KEY_PREFIX)) {
    return false
  }
  return /^\d+$/.test(key.slice(OPT_OUT_KEY_PREFIX.length))
}

/**
 * Drops the markers written by a build that used a different key.
 *
 * The keys are collected before any is removed, because removing during iteration
 * reindexes the store and would skip the entry after each removal.
 */
function sweepObsolete(storage: Storage): void {
  try {
    const obsolete: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || key === OPT_OUT_KEY || !isOptOutKey(key)) {
        continue
      }
      obsolete.push(key)
    }
    for (const key of obsolete) {
      storage.removeItem(key)
    }
  } catch {
    // A store that will not enumerate keeps its orphan. It costs one small entry and
    // affects nothing this build reads.
  }
}

/**
 * The real store, over `localStorage`.
 *
 * Every access is guarded, because `localStorage` throws rather than returning null in
 * some privacy modes. A store that cannot be read reports no opt-out and a store that
 * cannot be written forgets the decision for this session only - which is a worse
 * experience and never an error, and it is the same trade `data/cache.ts` makes.
 */
export function localOptOut(storage: Storage | null): OptOutStore {
  return {
    read: (): boolean => {
      if (storage === null) {
        return false
      }
      try {
        sweepObsolete(storage)
        return storage.getItem(OPT_OUT_KEY) !== null
      } catch {
        return false
      }
    },
    set: (optedOut: boolean): void => {
      if (storage === null) {
        return
      }
      try {
        if (optedOut) {
          // The value is never read. It is written as something a person looking at their
          // own storage can understand rather than as an empty string.
          storage.setItem(OPT_OUT_KEY, 'off')
        } else {
          storage.removeItem(OPT_OUT_KEY)
        }
        sweepObsolete(storage)
      } catch {
        // Nothing recoverable. The decision holds for this page and is asked again next
        // time, which is visible to the visitor as the panel offering the choice again.
      }
    },
  }
}
