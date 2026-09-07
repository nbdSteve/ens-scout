import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config/env'
import { CheckError, type CheckOptions } from '../verify/check'
import { CHECK_MAX_NAMES } from '../verify/contract'
import { CheckFormatError } from '../verify/parse'
import type { Verification } from '../verify/types'
import { useFreshCheck } from './useFreshCheck'

/**
 * The hook is tested through what the page would show: which boxes stay ticked, which
 * names have a current check, and what the page says when one fails. Nothing here
 * reaches a network - the client is injected, and the client's own behaviour is proved
 * in `verify/check.test.ts`.
 */

const FIXTURE_CONFIG: AppConfig = { apiBaseUrl: null, fixtureId: 'preview' }
const API_CONFIG: AppConfig = { apiBaseUrl: 'https://read.example', fixtureId: 'preview' }

const CHECKED_AT = '2026-03-01T12:00:00Z'
const EXPIRES_AT = '2026-03-01T12:01:00Z'

function verification(
  names: readonly string[],
  checkedAt = CHECKED_AT,
  expiresAt = EXPIRES_AT,
): Verification {
  return {
    checkedAt: new Date(checkedAt),
    expiresAt: new Date(expiresAt),
    names: [...names],
    results: names.map((name) => ({
      name,
      label: name.slice(0, -'.eth'.length),
      status: 'available' as const,
      expiry: null,
      graceEnds: null,
      premiumEnds: null,
    })),
  }
}

interface Verifier {
  readonly impl: (options: CheckOptions) => Promise<Verification>
  readonly calls: readonly CheckOptions[]
}

/** A verifier that records what it was asked and answers however the test says. */
function verifier(answer: (options: CheckOptions) => Promise<Verification>): Verifier {
  const calls: CheckOptions[] = []
  return {
    calls,
    impl: (options) => {
      calls.push(options)
      return answer(options)
    },
  }
}

function answering(): Verifier {
  return verifier((options) => Promise.resolve(verification(options.names)))
}

function refusing(cause: Error): Verifier {
  return verifier(() => Promise.reject(cause))
}

interface Deferred {
  readonly promise: Promise<Verification>
  settle: (view: Verification) => void
  fail: (cause: Error) => void
}

function deferred(): Deferred {
  let settle!: (view: Verification) => void
  let fail!: (cause: Error) => void
  const promise = new Promise<Verification>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return { promise, settle, fail }
}

function render(config: AppConfig, requestCheck: Verifier['impl']) {
  return renderHook(() => useFreshCheck(config, { requestCheck }))
}

describe('useFreshCheck selection', () => {
  it('reports no verifier in fixture mode and asks nothing', async () => {
    const fake = answering()
    const { result } = render(FIXTURE_CONFIG, fake.impl)

    expect(result.current.available).toBe(false)
    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await Promise.resolve()
    expect(fake.calls).toHaveLength(0)
  })

  it('ticks and unticks a name', () => {
    const { result } = render(API_CONFIG, answering().impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    expect([...result.current.selected]).toEqual(['aaa.eth'])
    act(() => {
      result.current.toggle('aaa.eth')
    })
    expect(result.current.selected.size).toBe(0)
  })

  /*
   * Charged here as well as in the client. A selection is built one click at a time, so
   * the refusal belongs at the click that would exceed the bound rather than at the
   * request that would be refused.
   */
  it('stops selecting at the bound and says the selection is full', () => {
    const { result } = render(API_CONFIG, answering().impl)

    act(() => {
      for (let index = 0; index < CHECK_MAX_NAMES + 3; index += 1) {
        result.current.toggle(`n${String(index)}.eth`)
      }
    })
    expect(result.current.selected.size).toBe(CHECK_MAX_NAMES)
    expect(result.current.full).toBe(true)
    // A name already ticked can still be unticked once the selection is full, or the
    // visitor could not change their mind about which names to check.
    act(() => {
      result.current.toggle('n0.eth')
    })
    expect(result.current.selected.has('n0.eth')).toBe(false)
    expect(result.current.full).toBe(false)
  })

  it('clears the whole selection when asked', () => {
    const { result } = render(API_CONFIG, answering().impl)

    act(() => {
      result.current.toggle('aaa.eth')
      result.current.toggle('bbb.eth')
    })
    act(() => {
      result.current.clearSelection()
    })
    expect(result.current.selected.size).toBe(0)
  })

  it('asks nothing when nothing is selected', async () => {
    const fake = answering()
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.check()
    })
    await Promise.resolve()
    expect(fake.calls).toHaveLength(0)
  })
})

describe('useFreshCheck verification', () => {
  it('verifies the selected names and records the instants', async () => {
    const fake = answering()
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.size).toBe(1)
    })

    const entry = result.current.verified.get('aaa.eth')
    expect(entry?.checkedAt.toISOString()).toBe('2026-03-01T12:00:00.000Z')
    expect(entry?.expiresAt.toISOString()).toBe('2026-03-01T12:01:00.000Z')
    expect(entry?.result.status).toBe('available')
    expect(fake.calls[0]?.names).toEqual(['aaa.eth'])
    expect(fake.calls[0]?.baseUrl).toBe('https://read.example')
  })

  it('reports which names a check in flight covers', async () => {
    const pending = deferred()
    const fake = verifier(() => pending.promise)
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
      result.current.toggle('bbb.eth')
    })
    act(() => {
      result.current.check()
    })
    expect([...result.current.pending].sort()).toEqual(['aaa.eth', 'bbb.eth'])
    expect(result.current.checking).toBe(true)

    await act(async () => {
      pending.settle(verification(['aaa.eth', 'bbb.eth']))
      await pending.promise
    })
    expect(result.current.checking).toBe(false)
    expect(result.current.pending.size).toBe(0)
  })

  /*
   * Each name keeps its own verification. Checking a third name must not take the first
   * two's outbound links away, which is the whole reason verification is held per name
   * rather than as one answer for one selection.
   */
  it('keeps every earlier verification when another check lands', async () => {
    const fake = answering()
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.has('aaa.eth')).toBe(true)
    })

    act(() => {
      result.current.toggle('aaa.eth')
      result.current.toggle('bbb.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.has('bbb.eth')).toBe(true)
    })
    expect(result.current.verified.has('aaa.eth')).toBe(true)
  })

  it('replaces an earlier verification of the same name', async () => {
    let instant = CHECKED_AT
    const fake = verifier((options) =>
      Promise.resolve(verification(options.names, instant, EXPIRES_AT)),
    )
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.size).toBe(1)
    })

    instant = '2026-03-01T12:00:30Z'
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.get('aaa.eth')?.checkedAt.toISOString()).toBe(
        '2026-03-01T12:00:30.000Z',
      )
    })
  })
})

describe('useFreshCheck failure', () => {
  /*
   * The rule the whole hook exists to hold. A failed check leaves the selection exactly
   * as the visitor set it, because choosing the names was their work and our failure is
   * not a reason to make them do it again.
   */
  it('keeps the selection after a failure', async () => {
    const fake = refusing(new CheckError('refused', 429, 'client_throttled'))
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
      result.current.toggle('bbb.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    expect([...result.current.selected].sort()).toEqual(['aaa.eth', 'bbb.eth'])
  })

  /*
   * And the other half: a failure adds nothing. There is no path here that reuses a
   * lapsed entry or copies a snapshot status across, so the gate goes on refusing the
   * outbound link and the page goes on showing the scan's status as the scan's status.
   */
  it('adds no verification when a check fails', async () => {
    const fake = refusing(new CheckError('refused', 503, 'upstream_unavailable'))
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    expect(result.current.verified.size).toBe(0)
  })

  it('keeps verifications it already had when a later check fails', async () => {
    let fail = false
    const fake = verifier((options) =>
      fail
        ? Promise.reject(new CheckError('refused', 503, 'upstream_busy'))
        : Promise.resolve(verification(options.names)),
    )
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.has('aaa.eth')).toBe(true)
    })

    fail = true
    act(() => {
      result.current.toggle('aaa.eth')
      result.current.toggle('bbb.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    expect(result.current.verified.has('aaa.eth')).toBe(true)
  })

  it.each([
    ['a throttled client', new CheckError('x', 429, 'client_throttled'), 'throttled', true],
    ['a timed-out check', new CheckError('x', 503, 'check_timed_out'), 'timeout', true],
    ['an unreachable endpoint', new CheckError('x', null), 'unavailable', true],
    // Retryable: the response most likely to be malformed came from something other
    // than the endpoint - a proxy, a portal, a captive network - so a retry can land on
    // the real one.
    ['an answer this build refused', new CheckFormatError('bad'), 'malformed', true],
  ] as const)('describes %s', async (_what, cause, kind, retryable) => {
    const { result } = render(API_CONFIG, refusing(cause).impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure?.kind).toBe(kind)
    })
    expect(result.current.failure?.retryable).toBe(retryable)
    expect(result.current.failure?.message).not.toBe('')
  })

  it('clears the failure when another check starts', async () => {
    let fail = true
    const fake = verifier((options) =>
      fail
        ? Promise.reject(new CheckError('refused', 503, 'upstream_busy'))
        : Promise.resolve(verification(options.names)),
    )
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })

    fail = false
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.has('aaa.eth')).toBe(true)
    })
    expect(result.current.failure).toBeNull()
  })

  it('dismisses a failure when the visitor closes it', async () => {
    const { result } = render(API_CONFIG, refusing(new CheckError('x', 503)).impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull()
    })
    act(() => {
      result.current.dismissFailure()
    })
    expect(result.current.failure).toBeNull()
  })
})

describe('useFreshCheck cancellation', () => {
  /*
   * A second check replaces the first. The first is cancelled, and a cancelled check is
   * not a failed one: a visitor who changed their selection must not be shown an error
   * about the request they replaced.
   */
  it('drops a replaced check without reporting it', async () => {
    const first = deferred()
    let call = 0
    const fake = verifier((options) => {
      call += 1
      return call === 1 ? first.promise : Promise.resolve(verification(options.names))
    })
    const { result } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    act(() => {
      result.current.check()
    })
    await waitFor(() => {
      expect(result.current.verified.has('aaa.eth')).toBe(true)
    })

    // The replaced request settles late, and it must change nothing.
    await act(async () => {
      first.fail(new CheckError('cancelled', null))
      await first.promise.catch(() => undefined)
    })
    expect(result.current.failure).toBeNull()
    expect(result.current.verified.size).toBe(1)
    expect(fake.calls[0]?.signal?.aborted).toBe(true)
  })

  it('abandons a check in flight when the page goes away', async () => {
    const pending = deferred()
    const fake = verifier(() => pending.promise)
    const { result, unmount } = render(API_CONFIG, fake.impl)

    act(() => {
      result.current.toggle('aaa.eth')
    })
    act(() => {
      result.current.check()
    })
    expect(fake.calls[0]?.signal?.aborted).toBe(false)

    unmount()
    expect(fake.calls[0]?.signal?.aborted).toBe(true)

    // Settling afterwards must not reach a state nothing renders.
    await act(async () => {
      pending.settle(verification(['aaa.eth']))
      await pending.promise
    })
  })
})
