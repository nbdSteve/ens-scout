/**
 * `Storage` implementations for tests.
 *
 * The snapshot cache sweeps keys written by previous wire versions, so its tests need to
 * inspect surviving keys and exercise a store that refuses writes.
 */

/**
 * A `Storage` backed by a map.
 *
 * `refuse` rejects a write the way a full store does, and sees the entries that are
 * present, so a test can make room by removing something and have the retry succeed.
 */
export function memoryStorage(
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

/**
 * A `Storage` that throws on every access, which is what some privacy modes really do:
 * the property is present and touching it raises rather than returning null. Reading a
 * count of keys throws too, so a sweep cannot even enumerate.
 */
export function hostileStorage(): Storage {
  const raise = (): never => {
    throw new DOMException('access denied', 'SecurityError')
  }
  return {
    get length(): number {
      return raise()
    },
    clear: raise,
    getItem: raise,
    key: raise,
    removeItem: raise,
    setItem: raise,
  }
}

/** Every key a store holds, sorted, read the way the sweeps read them. */
export function keysOf(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) {
      keys.push(key)
    }
  }
  return keys.sort()
}
