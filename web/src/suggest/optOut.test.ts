import { describe, expect, it } from 'vitest'
import { hostileStorage, keysOf, memoryStorage } from '../test/storage'
import { OPT_OUT_KEY, OPT_OUT_KEY_PREFIX, OPT_OUT_VERSION } from './contract'
import { localOptOut } from './optOut'

/**
 * The one durable thing this feature writes.
 *
 * Two promises are checked. The first is that a no stays a no: a visitor who turned the
 * model off gets a page that does not fetch two hundred megabytes on their next visit,
 * which means the marker has to survive a fresh store being read by a fresh process. The
 * second is that a store which will not co-operate is never an error - a privacy mode
 * that throws on every access has to leave the page working, with the model simply asked
 * about again.
 *
 * Nothing here asserts on the stored value, because nothing reads it. The key existing is
 * the whole statement, so a test that pinned the value would be pinning something the
 * implementation is free to change.
 */

/** A marker written by a build that used an earlier key. */
const OBSOLETE_KEY = `${OPT_OUT_KEY_PREFIX}${String(OPT_OUT_VERSION - 1)}`

/** Keys that share the prefix and are not markers. Neither may be swept. */
const UNVERSIONED_KEY = `${OPT_OUT_KEY_PREFIX}Next`
const SUFFIXED_KEY = `${OPT_OUT_KEY}.probe`

/** An entry another feature on this origin owns. */
const UNRELATED_KEY = 'ens-scout.snapshot.v3'

describe('reading the opt-out', () => {
  it('reports no opt-out for a store that has never held one', () => {
    expect(localOptOut(memoryStorage()).read()).toBe(false)
  })

  it('reports an opt-out from the marker alone', () => {
    expect(localOptOut(memoryStorage({ [OPT_OUT_KEY]: 'off' })).read()).toBe(true)
  })

  /* Whatever the entry holds is ignored, so there is no shape a corrupt one could take. */
  it('reads the key rather than its value', () => {
    expect(localOptOut(memoryStorage({ [OPT_OUT_KEY]: '' })).read()).toBe(true)
    expect(localOptOut(memoryStorage({ [OPT_OUT_KEY]: 'on' })).read()).toBe(true)
    expect(localOptOut(memoryStorage({ [OPT_OUT_KEY]: '{"broken"' })).read()).toBe(true)
  })

  /*
   * The version is in the key, so a bumped version leaves the previous marker suppressing
   * a feature through an entry nothing reads. It is swept on the read rather than only on
   * the write, because a visitor who never touches the control never reaches a write.
   */
  it('ignores a marker from a version this build does not use', () => {
    const storage = memoryStorage({ [OBSOLETE_KEY]: 'off' })
    expect(localOptOut(storage).read()).toBe(false)
    expect(keysOf(storage)).toEqual([])
  })
})

describe('writing the opt-out', () => {
  it('remembers a no, and a fresh reader over the same store sees it', () => {
    const storage = memoryStorage()
    localOptOut(storage).set(true)
    // A second store object over the same entries is what the next page load really is.
    expect(localOptOut(storage).read()).toBe(true)
    expect(keysOf(storage)).toEqual([OPT_OUT_KEY])
  })

  it('forgets it again when the visitor turns the model back on', () => {
    const storage = memoryStorage({ [OPT_OUT_KEY]: 'off' })
    localOptOut(storage).set(false)
    expect(localOptOut(storage).read()).toBe(false)
    expect(keysOf(storage)).toEqual([])
  })

  it('leaves everything on the origin that is not one of these markers', () => {
    const storage = memoryStorage({
      [OBSOLETE_KEY]: 'off',
      [UNVERSIONED_KEY]: 'off',
      [SUFFIXED_KEY]: '1',
      [UNRELATED_KEY]: '{"stored_at":"2026-03-01T13:00:00Z"}',
    })

    localOptOut(storage).set(true)

    expect(keysOf(storage)).toEqual(
      [OPT_OUT_KEY, UNVERSIONED_KEY, SUFFIXED_KEY, UNRELATED_KEY].sort(),
    )
  })

  /*
   * The sweep collects before it removes. A store that reindexes on every removal would
   * otherwise skip the entry after each one, which needs two obsolete markers to show:
   * with one there is nothing after it to skip.
   */
  it('sweeps every obsolete marker, not every other one', () => {
    const storage = memoryStorage({
      [`${OPT_OUT_KEY_PREFIX}90`]: 'off',
      [`${OPT_OUT_KEY_PREFIX}91`]: 'off',
      [`${OPT_OUT_KEY_PREFIX}92`]: 'off',
      [UNRELATED_KEY]: 'kept',
    })

    localOptOut(storage).set(true)

    expect(keysOf(storage)).toEqual([OPT_OUT_KEY, UNRELATED_KEY].sort())
  })
})

describe('a store that will not co-operate', () => {
  /*
   * No store at all, which is what `window.localStorage` is when the property is missing.
   * The decision is then held for this page only, and the panel offers the choice again
   * next time, which is a worse experience and never a failure.
   */
  it('treats an absent store as no opt-out and accepts a write into nothing', () => {
    const store = localOptOut(null)
    expect(store.read()).toBe(false)
    expect(() => {
      store.set(true)
    }).not.toThrow()
    expect(store.read()).toBe(false)
  })

  it('treats a store that throws on every access the same way', () => {
    const store = localOptOut(hostileStorage())
    expect(store.read()).toBe(false)
    expect(() => {
      store.set(true)
    }).not.toThrow()
    expect(() => {
      store.set(false)
    }).not.toThrow()
    expect(store.read()).toBe(false)
  })

  /*
   * A full store, which is the one case where the marker matters and cannot be written.
   * The write is abandoned and the obsolete marker is left where it is, because the sweep
   * runs after the write it belongs to. Nothing is stranded by that: the read path sweeps
   * too, so the next read drops the marker and reports the honest answer, which is that
   * this store holds no opt-out this build would act on.
   */
  it('reports no opt-out when the marker cannot be written', () => {
    const storage = memoryStorage({ [OBSOLETE_KEY]: 'off', [UNRELATED_KEY]: 'kept' }, () => true)
    const store = localOptOut(storage)

    expect(() => {
      store.set(true)
    }).not.toThrow()

    expect(store.read()).toBe(false)
    expect(keysOf(storage)).toEqual([UNRELATED_KEY])
  })
})
