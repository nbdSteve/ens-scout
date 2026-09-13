import { describe, expect, it } from 'vitest'
import {
  describeGenerateFailure,
  describeLoadFailure,
  describeSupport,
  SuggestTimeoutError,
  type SuggestFailure,
  type SuggestFailureKind,
} from './failure'
import { SuggestFormatError } from './parse'
import type { SupportVerdict } from './engine/types'

/**
 * What a visitor is told when the model does not answer.
 *
 * The classification is checked case by case, because each kind exists to say something
 * different and a cause landing in the wrong one is a sentence that is not true: telling
 * somebody to close other tabs about a failure that had nothing to do with memory, or
 * calling a refused answer a download problem.
 *
 * The rule the whole module exists for is checked separately and does not depend on any of
 * the classification: whatever the cause said, the sentence is a fixed literal. The
 * library's own messages carry asset URLs, adapter strings, and buffer sizes, so the text
 * that described a failure is exactly the text that must not be shown.
 */

/** A distinctive token no sentence here may ever carry. */
const LEAK = 'model-host.example'

/**
 * Runs with the device reporting itself offline.
 *
 * `navigator.onLine` is a getter on jsdom's prototype, so it is replaced on the instance
 * and removed again, which restores the inherited one rather than pinning it to true.
 */
function whileOffline<T>(work: () => T): T {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  try {
    return work()
  } finally {
    delete (navigator as unknown as Record<string, unknown>)['onLine']
  }
}

describe('a device that cannot run the model', () => {
  it('says nothing at all when it can', () => {
    expect(describeSupport('ok')).toBeNull()
  })

  /*
   * Three verdicts and three sentences, because a browser with no WebGPU, an adapter that
   * cannot run these shaders, and a probe that failed are three different things - and a
   * visitor who reads the wrong one is told to change something that would not help.
   */
  it('names which of the three it was', () => {
    const cases: readonly (readonly [SupportVerdict, SuggestFailureKind])[] = [
      ['no-webgpu', 'unsupported'],
      ['no-feature', 'unsupported-feature'],
      ['probe-failed', 'probe-failed'],
    ]
    for (const [verdict, kind] of cases) {
      expect(describeSupport(verdict)).toMatchObject({ stage: 'support', kind })
    }
  })

  /*
   * Nothing about this page or this moment caused any of them, so there is nothing to try
   * again. A retry offered here would be a button that cannot succeed, which is the same
   * mistake `components/recovery.ts` exists to avoid on the snapshot path.
   */
  it('offers no retry for any of them', () => {
    for (const verdict of ['no-webgpu', 'no-feature', 'probe-failed'] as const) {
      expect(describeSupport(verdict)?.retryable).toBe(false)
    }
  })

  it('tells a browser with no WebGPU that the names are still ranked', () => {
    expect(describeSupport('no-webgpu')?.message).toBe(
      'This browser cannot run the on-device model, so the names below are ranked without it.',
    )
  })
})

describe('a failure while loading', () => {
  it('reports the page’s own bound as a timeout', () => {
    const failure = describeLoadFailure(new SuggestTimeoutError('load exceeded its bound'))
    expect(failure.stage).toBe('loading')
    expect(failure.kind).toBe('load-timeout')
    expect(failure.retryable).toBe(true)
  })

  /*
   * Matching text is the only classification available: the library reports this as a
   * message, and the underlying failure arrives as a WebGPU device-lost reason or as a
   * `RangeError` from the allocator. These are the real forms, from the library, from
   * WebGPU, and from the JavaScript engine.
   */
  it('recognises the ways a device says it ran out of memory', () => {
    const causes: readonly unknown[] = [
      new RangeError('Array buffer allocation failed'),
      new Error('WebGPU device was lost: out of memory'),
      new Error('Requested buffer size exceeds the limit of maxBufferSize'),
      'OutOfMemoryError',
    ]
    for (const cause of causes) {
      expect(describeLoadFailure(cause).kind).toBe('memory')
    }
  })

  /* Room to try again, which is why this one sentence suggests an action. */
  it('tells a visitor what might help when memory ran out', () => {
    const failure = describeLoadFailure(new RangeError('Array buffer allocation failed'))
    expect(failure.message).toBe(
      'This device did not have enough memory for the model. Closing other tabs and trying again may help.',
    )
    expect(failure.retryable).toBe(true)
  })

  it('recognises a fetch that did not happen', () => {
    const causes: readonly unknown[] = [
      new TypeError('Failed to fetch'),
      new TypeError('Load failed'),
      new Error('error loading dynamically imported module'),
    ]
    for (const cause of causes) {
      expect(describeLoadFailure(cause).kind).toBe('blocked')
    }
  })

  /*
   * Offline is a different sentence from blocked, because the two ask different things of
   * a visitor: one is a connection they can restore and the other is a fetch that failed
   * with a connection present. `navigator.onLine` is trusted only in the false direction
   * and only to choose between these two, never to decide whether to try.
   */
  it('says offline rather than blocked when the device says it is offline', () => {
    expect(whileOffline(() => describeLoadFailure(new TypeError('Failed to fetch')).kind)).toBe(
      'offline',
    )
    // A cause that names nothing recognisable is still offline, because the device is.
    expect(whileOffline(() => describeLoadFailure(new Error('nothing familiar')).kind)).toBe(
      'offline',
    )
  })

  /*
   * Memory is judged before the connection. An offline device that also ran out of memory
   * has a specific problem and a specific thing to try, and reporting the connection would
   * send the visitor after the wrong one.
   */
  it('prefers the memory sentence over the offline one', () => {
    expect(whileOffline(() => describeLoadFailure(new Error('device lost')).kind)).toBe('memory')
  })

  /*
   * The honest default. A cause nobody recognised is not guessed at, because every guess
   * here is a sentence telling a visitor to do something specific.
   */
  it('falls back to a plain load failure for anything unrecognised', () => {
    for (const cause of [new Error('something else entirely'), null, undefined, 42, {}]) {
      expect(describeLoadFailure(cause).kind).toBe('load-failed')
    }
  })
})

describe('a failure while generating', () => {
  /*
   * Checked before anything else and never treated as a network or memory condition: the
   * model ran, produced text, and `parse.ts` would not use it. It is also the one failure
   * here worth asking again about, because a small model asked twice does not always
   * answer the same way and the model is already loaded.
   */
  it('reports an answer this build refused, whatever the refusal said', () => {
    const failure = describeGenerateFailure(new SuggestFormatError('the answer is not JSON'))
    expect(failure.stage).toBe('generation')
    expect(failure.kind).toBe('generate-refused')
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe(
      'The model’s answer did not match what this page accepts, so it was not used. The names below are ranked without it.',
    )
  })

  it('reports the page’s own bound as a timeout', () => {
    expect(describeGenerateFailure(new SuggestTimeoutError('too slow')).kind).toBe(
      'generate-timeout',
    )
  })

  it('recognises running out of memory mid-generation', () => {
    expect(describeGenerateFailure(new Error('device lost')).kind).toBe('memory')
  })

  /*
   * No network classification on this path, deliberately. Generation is local: a fetch
   * failure during it would be some other request, and calling it a download problem would
   * describe a download that was not happening.
   */
  it('falls back to a plain generation failure, including for a fetch failure', () => {
    for (const cause of [new Error('anything'), new TypeError('Failed to fetch'), 'nonsense']) {
      expect(describeGenerateFailure(cause).kind).toBe('generate-failed')
    }
  })
})

describe('what reaches a screen', () => {
  /** Every failure this module can produce, so the checks below cover all of them. */
  const every: readonly SuggestFailure[] = [
    describeSupport('no-webgpu'),
    describeSupport('no-feature'),
    describeSupport('probe-failed'),
    describeLoadFailure(new SuggestTimeoutError('bound')),
    describeLoadFailure(new RangeError('Array buffer allocation failed')),
    describeLoadFailure(new TypeError('Failed to fetch')),
    whileOffline(() => describeLoadFailure(new TypeError('Failed to fetch'))),
    describeLoadFailure(new Error('unrecognised')),
    describeGenerateFailure(new SuggestFormatError('refused')),
    describeGenerateFailure(new SuggestTimeoutError('bound')),
    describeGenerateFailure(new Error('unrecognised')),
  ].filter((failure): failure is SuggestFailure => failure !== null)

  it('covers all eleven kinds, so the rules below are checked against every one', () => {
    expect(new Set(every.map((failure) => failure.kind)).size).toBe(11)
  })

  it('is a whole sentence in every case', () => {
    for (const failure of every) {
      expect(failure.message.endsWith('.')).toBe(true)
      expect(failure.message.length).toBeGreaterThan(30)
    }
  })

  /*
   * The rule the module exists for. Two causes of the same kind carrying wildly different
   * text produce the same sentence, and no sentence carries any of that text - which is
   * what keeps an asset URL, an adapter string, or a buffer size off the screen.
   */
  it('quotes nothing the cause said', () => {
    const noisy = new TypeError(`Failed to fetch https://${LEAK}/weights/shard-3.bin: 47185920`)
    const plain = new TypeError('Failed to fetch')
    expect(describeLoadFailure(noisy).kind).toBe('blocked')
    expect(describeLoadFailure(noisy).message).toBe(describeLoadFailure(plain).message)

    for (const failure of [...every, describeLoadFailure(noisy)]) {
      expect(failure.message).not.toContain(LEAK)
      expect(failure.message).not.toContain('47185920')
      expect(failure.message).not.toContain('http')
    }
  })
})
