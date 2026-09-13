import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResults } from '../test/factory'
import {
  GENERATE_TIMEOUT_MS,
  INIT_TIMEOUT_MS,
  SLOW_AFTER_MS,
  START_GRACE_MS,
} from '../suggest/contract'
import type {
  EngineModule,
  LoadRequest,
  SuggestEngine,
  SupportVerdict,
} from '../suggest/engine/types'
import type { OptOutStore } from '../suggest/optOut'
import type { SuggestPrompt } from '../suggest/prompt'
import type { SnapshotResult } from '../snapshot/types'
import { buildShortlist, shortlistNames, shortlistSuggestions } from '../suggest/shortlist'
import { vibeById, type Preference } from '../suggest/vibes'
import { useSuggest, type SuggestDeps, type SuggestInput, type SuggestStore } from './useSuggest'

/**
 * The state machine, exercised through what the panel would show.
 *
 * The model boundary is a fake and there is no WebGPU, no library chunk, and no model
 * anywhere in here. That is the requirement rather than a convenience: a test that loaded
 * a real model would be a test that contacted a model host. `fetch` is stubbed to count
 * calls for the same reason, so the file can state as a fact that none of this reaches a
 * network.
 *
 * Four claims are what the tests are arranged around.
 *
 * The names come first. Nothing is probed, no chunk is fetched, and no byte of a model is
 * requested until the page says it is interactive and then a grace has passed with the
 * controls on screen unused - which is what makes a two-hundred-megabyte download
 * refusable before it starts rather than after.
 *
 * Every failure leaves the page working. An unsupported device, a cancelled load, a load
 * that ran out of memory or out of time, and an answer this build refused are five states
 * on a panel, and in every one of them asking for names still produces names.
 *
 * An answer is never more than the shortlist it was drawn from. The model reorders exact
 * names; explanations remain repository-owned, and anything else is refused whole.
 *
 * Nothing retries itself. One automatic attempt, and after that a visitor has to ask.
 */

/** Counted rather than allowed: nothing in this file may reach a network. */
let networkCalls = 0

beforeEach(() => {
  vi.useFakeTimers()
  networkCalls = 0
  vi.stubGlobal('fetch', () => {
    networkCalls += 1
    throw new Error('nothing in this test may reach a network')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function vibe(id: string): Preference {
  const found = vibeById(id)
  if (found === null) {
    throw new Error(`the ${id} vibe is gone, so this test is checking nothing`)
  }
  return { kind: 'vibe', vibe: found }
}

const NATURE = vibe('nature')
const COSMIC = vibe('cosmic')

/** Rows the way `App` hands them over: already filtered by the visitor's own controls. */
const ROWS = buildResults(['moss', 'fern', 'quartz', 'zzzz'])

/** A narrower set, for the case where a name the snapshot holds is outside the shortlist. */
const NARROWED = buildResults(['moss', 'fern'])

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (cause: unknown) => void = () => undefined
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/**
 * A well-formed answer, written out here rather than built by anything in `src/`.
 *
 * `parse.ts` owns every refusal and is tested exhaustively against hand-written documents.
 * What this file needs is the two ends of the wiring: an answer the parser accepts, and
 * answers it does not.
 */
function answerNaming(names: readonly string[]): string {
  return JSON.stringify({ picks: names.map((name) => ({ name })) })
}

interface Calls {
  gpu: number
  module: number
  probe: number
  isCached: number
  load: number
  generate: number
  dispose: number
}

interface Harness {
  readonly deps: SuggestDeps
  readonly calls: Calls
  /** What every load resolves to, so a test can settle a deferred one with it. */
  readonly engine: SuggestEngine
  /** Every prompt the engine was given, in order. */
  readonly prompts: SuggestPrompt[]
  /** Every load request, so a test can read its signal or report progress by hand. */
  readonly requests: LoadRequest[]
}

interface Options {
  readonly webgpu?: boolean
  readonly support?: SupportVerdict
  readonly stored?: boolean
  /** Shared between two renders, which is what a second visit really is. */
  readonly optOut?: OptOutStore
  readonly module?: (available: EngineModule) => Promise<EngineModule>
  readonly load?: (request: LoadRequest, engine: SuggestEngine) => Promise<SuggestEngine>
  readonly generate?: (prompt: SuggestPrompt) => Promise<string>
}

function optOutStore(initial = false): OptOutStore {
  let remembered = initial
  return {
    read: () => remembered,
    set: (next) => {
      remembered = next
    },
  }
}

function harness(options: Options = {}): Harness {
  const calls: Calls = {
    gpu: 0,
    module: 0,
    probe: 0,
    isCached: 0,
    load: 0,
    generate: 0,
    dispose: 0,
  }
  const prompts: SuggestPrompt[] = []
  const requests: LoadRequest[] = []

  const engine: SuggestEngine = {
    generate: (prompt) => {
      calls.generate += 1
      prompts.push(prompt)
      return options.generate?.(prompt) ?? Promise.resolve(answerNaming(prompt.allowed.slice(0, 2)))
    },
    dispose: () => {
      calls.dispose += 1
      return Promise.resolve()
    },
  }

  const engineModule: EngineModule = {
    probeSupport: () => {
      calls.probe += 1
      return Promise.resolve(options.support ?? 'ok')
    },
    isCached: () => {
      calls.isCached += 1
      return Promise.resolve(options.stored ?? false)
    },
    loadEngine: (request) => {
      calls.load += 1
      requests.push(request)
      if (options.load !== undefined) {
        return options.load(request, engine)
      }
      request.onProgress({ fraction: 0.5, text: 'Fetching model weights' })
      return Promise.resolve(engine)
    },
  }

  return {
    calls,
    engine,
    prompts,
    requests,
    deps: {
      hasWebGpu: () => {
        calls.gpu += 1
        return options.webgpu ?? true
      },
      loadModule: () => {
        calls.module += 1
        return options.module?.(engineModule) ?? Promise.resolve(engineModule)
      },
      optOut: options.optOut ?? optOutStore(),
    },
  }
}

function render(
  input: SuggestInput,
  deps: SuggestDeps,
): RenderHookResult<SuggestStore, SuggestInput> {
  return renderHook((current: SuggestInput) => useSuggest(current, deps), { initialProps: input })
}

/** The page interactive, with the rows a visitor's filters admit. */
function live(results: readonly SnapshotResult[] = ROWS): SuggestInput {
  return { interactive: true, results }
}

/**
 * Moves the clock and lets what it started settle.
 *
 * The load path is a chain of awaits behind one timer, and a chain settles on microtasks
 * rather than on the clock, so an empty tick follows: `advanceTimersByTimeAsync` yields a
 * real macrotask after the timers it fires, which drains the queue without moving time.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** The shortlist the model was really offered on its nth request. */
function offered(harnessed: Harness, index = 0): readonly string[] {
  const prompt = harnessed.prompts[index]
  if (prompt === undefined) {
    throw new Error('the model was never asked, and this test needs it to have been')
  }
  return prompt.allowed
}

function at(names: readonly string[], index: number): string {
  const name = names[index]
  if (name === undefined) {
    throw new Error(`there is no name at ${String(index)}, so this test is checking nothing`)
  }
  return name
}

describe('nothing before the names', () => {
  /*
   * The whole point of the interactivity gate. A page still parsing a snapshot must not be
   * competing for bandwidth or for the main thread with an optional model, so the gate is
   * checked against the cheapest thing the load path does rather than against the fetch:
   * the device is not even asked whether it has WebGPU.
   */
  it('probes nothing at all while the page is not interactive yet', async () => {
    const model = harness()
    const view = render({ interactive: false, results: ROWS }, model.deps)

    expect(view.result.current.phase).toBe('waiting')
    await advance(START_GRACE_MS * 3)

    expect(view.result.current.phase).toBe('waiting')
    expect(model.calls.gpu).toBe(0)
    expect(model.calls.module).toBe(0)
  })

  it('waits out the grace after the page becomes interactive, then loads', async () => {
    const model = harness()
    const view = render({ interactive: false, results: ROWS }, model.deps)

    act(() => {
      view.rerender(live())
    })
    await advance(START_GRACE_MS - 1)

    // Still nothing fetched, which is what makes the controls on screen worth anything.
    expect(view.result.current.phase).toBe('waiting')
    expect(model.calls.gpu).toBe(0)

    await advance(1)
    expect(view.result.current.phase).toBe('ready')
    expect(model.calls.load).toBe(1)
  })

  /*
   * The grace exists to be used. A visitor who says no inside it is never charged for the
   * download, so the assertion is on the library chunk as well as on the model: neither is
   * requested.
   */
  it('never starts when the visitor pauses inside the grace', async () => {
    const model = harness()
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS - 1000)
    act(() => {
      view.result.current.pause()
    })
    expect(view.result.current.phase).toBe('paused')

    await advance(START_GRACE_MS * 3)
    expect(view.result.current.phase).toBe('paused')
    expect(model.calls.gpu).toBe(0)
    expect(model.calls.module).toBe(0)
  })

  it('starts disabled and stays there when the device already holds a no', async () => {
    const model = harness({ optOut: optOutStore(true) })
    const view = render(live(), model.deps)

    expect(view.result.current.phase).toBe('disabled')
    await advance(START_GRACE_MS * 3)

    expect(view.result.current.phase).toBe('disabled')
    expect(model.calls.gpu).toBe(0)
  })
})

describe('stopping it', () => {
  /*
   * Pausing and disabling are different promises and the difference is durable: one is for
   * this page, and the other has to survive the page going away. A second render over the
   * same store is what a later visit really is.
   */
  it('remembers a disable across a fresh page, and a pause does not', async () => {
    const remembered = optOutStore()
    const model = harness({ optOut: remembered })

    const first = render(live(), model.deps)
    act(() => {
      first.result.current.pause()
    })
    first.unmount()

    const second = render(live(), model.deps)
    expect(second.result.current.phase).toBe('waiting')
    act(() => {
      second.result.current.disable()
    })
    expect(second.result.current.phase).toBe('disabled')
    expect(remembered.read()).toBe(true)
    second.unmount()

    const third = render(live(), model.deps)
    expect(third.result.current.phase).toBe('disabled')
    await advance(START_GRACE_MS * 3)
    expect(model.calls.gpu).toBe(0)
  })

  /* Turning it back on undoes the no and offers the choice again rather than taking it. */
  it('takes a re-enable as paused rather than as a load', async () => {
    const remembered = optOutStore(true)
    const model = harness({ optOut: remembered })
    const view = render(live(), model.deps)

    act(() => {
      view.result.current.enable()
    })
    expect(view.result.current.phase).toBe('paused')
    expect(remembered.read()).toBe(false)

    await advance(START_GRACE_MS * 3)
    expect(view.result.current.phase).toBe('paused')
    expect(model.calls.load).toBe(0)
  })

  /*
   * An attempt the visitor asked for skips the grace. The wait exists only to make an
   * unasked download refusable, and somebody who has just pressed the button has already
   * decided.
   */
  it('starts immediately when the visitor asks, without the grace', async () => {
    const model = harness()
    const view = render(live(), model.deps)

    act(() => {
      view.result.current.pause()
    })
    act(() => {
      view.result.current.resume()
    })
    expect(view.result.current.phase).toBe('waiting')

    await advance(0)
    expect(view.result.current.phase).toBe('ready')
  })

  it('replaces model provenance with a deterministic answer when paused or disabled', async () => {
    for (const stop of ['pause', 'disable'] as const) {
      const model = harness()
      const view = render(live(), model.deps)

      await advance(START_GRACE_MS)
      act(() => {
        view.result.current.suggest(NATURE)
      })
      await advance(0)
      expect(view.result.current.answer?.source).toBe('model')

      act(() => {
        view.result.current[stop]()
      })

      expect(view.result.current.answer?.source).toBe('deterministic')
      expect(view.result.current.phase).toBe(stop === 'pause' ? 'paused' : 'disabled')
      view.unmount()
    }
  })

  /*
   * Cancelling part way through is a different state from pausing before the start,
   * because the visitor has spent bandwidth and the panel has to say so. The load is also
   * really asked to stop: the signal it was given is aborted, and the engine it eventually
   * resolves to is released rather than kept.
   */
  it('cancels a load in flight, aborts it, and releases what arrives late', async () => {
    const loading = deferred<SuggestEngine>()
    const model = harness({ load: () => loading.promise })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.phase).toBe('loading')

    act(() => {
      view.result.current.pause()
    })
    expect(view.result.current.phase).toBe('cancelled')
    expect(view.result.current.progress).toBeNull()

    const request = model.requests[0]
    expect(request?.signal.aborted).toBe(true)

    // Progress reported after a cancellation is not the state of anything.
    act(() => {
      request?.onProgress({ fraction: 0.9, text: 'Fetching model weights' })
    })
    expect(view.result.current.progress).toBeNull()

    loading.resolve(model.engine)
    await advance(0)
    expect(view.result.current.phase).toBe('cancelled')
    expect(model.calls.dispose).toBe(1)
  })

  it('releases a loaded model when the page goes away', async () => {
    const model = harness()
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.phase).toBe('ready')

    view.unmount()
    expect(model.calls.dispose).toBe(1)
  })
})

describe('a device that cannot run it', () => {
  /*
   * The cheapest refusal costs the least. A browser with no WebGPU is refused before the
   * library chunk is requested, so an unsupported device downloads neither it nor a byte
   * of a model - and the panel says so rather than the page reporting an error.
   */
  it('refuses a browser with no WebGPU before fetching the library', async () => {
    const model = harness({ webgpu: false })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)

    expect(view.result.current.phase).toBe('unavailable')
    expect(view.result.current.failure?.kind).toBe('unsupported')
    expect(model.calls.module).toBe(0)
  })

  it('refuses an adapter without the feature before fetching a model', async () => {
    const model = harness({ support: 'no-feature' })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)

    expect(view.result.current.phase).toBe('unavailable')
    expect(view.result.current.failure?.kind).toBe('unsupported-feature')
    expect(model.calls.probe).toBe(1)
    expect(model.calls.load).toBe(0)
  })

  it('reports a probe that failed as its own state', async () => {
    const model = harness({ support: 'probe-failed' })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)

    expect(view.result.current.failure?.kind).toBe('probe-failed')
    expect(model.calls.load).toBe(0)
  })

  /* Every one of these still answers, which is the whole reason the fallback exists. */
  it('still recommends names on a device that cannot run the model', async () => {
    const model = harness({ webgpu: false })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })

    const answer = view.result.current.answer
    expect(answer?.source).toBe('deterministic')
    expect(answer?.suggestions.length).toBeGreaterThan(0)
    expect(view.result.current.failure?.kind).toBe('unsupported')
    expect(view.result.current.failure?.retryable).toBe(false)
    expect(model.calls.generate).toBe(0)
  })

  it('exposes no pause or retry capability for an unsupported device', async () => {
    const model = harness({ webgpu: false })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.capabilities.pause).toBe(false)
    expect(view.result.current.capabilities.resume).toBe(false)

    act(() => {
      view.result.current.pause()
      view.result.current.resume()
    })

    await advance(0)
    expect(view.result.current.phase).toBe('unavailable')
    expect(model.calls.module).toBe(0)
  })
})

describe('loading', () => {
  it('reports the library’s own progress, and clears it when the model is ready', async () => {
    const loading = deferred<SuggestEngine>()
    const model = harness({
      load: (request) => {
        request.onProgress({ fraction: 0.25, text: 'Fetching param cache' })
        return loading.promise
      },
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.progress).toEqual({ fraction: 0.25, text: 'Fetching param cache' })

    act(() => {
      model.requests[0]?.onProgress({ fraction: null, text: 'Loading GPU shader modules' })
    })
    expect(view.result.current.progress).toEqual({
      fraction: null,
      text: 'Loading GPU shader modules',
    })

    loading.resolve(model.engine)
    await advance(0)
    expect(view.result.current.phase).toBe('ready')
    expect(view.result.current.progress).toBeNull()
  })

  /*
   * The cached flag is what lets the panel stop announcing a download that will not
   * happen. It is read from the probe before the load and then set unconditionally after
   * one completes, because a finished load is proof the assets are stored whatever the
   * probe was able to say.
   */
  it('reports a stored model from the probe, and after any completed load', async () => {
    const stored = harness({ stored: true })
    const storedView = render(live(), stored.deps)
    await advance(START_GRACE_MS)
    expect(storedView.result.current.cached).toBe(true)

    const fresh = harness({ stored: false })
    const freshView = render(live(), fresh.deps)
    expect(freshView.result.current.cached).toBe(false)
    await advance(START_GRACE_MS)
    expect(freshView.result.current.cached).toBe(true)
  })

  /*
   * Saying it is slow, and then giving up. Both are bounds on a visitor's patience rather
   * than on the device: the model is asked to stop at the timeout, and the panel offers
   * the attempt back rather than making it again.
   */
  it('says a load is slow, then gives up at its own bound', async () => {
    const model = harness({ load: () => new Promise<SuggestEngine>(() => undefined) })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.slow).toBe(false)

    await advance(SLOW_AFTER_MS)
    expect(view.result.current.phase).toBe('loading')
    expect(view.result.current.slow).toBe(true)

    await advance(INIT_TIMEOUT_MS - SLOW_AFTER_MS)
    expect(view.result.current.phase).toBe('unavailable')
    expect(view.result.current.failure?.kind).toBe('load-timeout')
    expect(view.result.current.failure?.retryable).toBe(true)
    expect(model.requests[0]?.signal.aborted).toBe(true)
  })

  it('keeps an aborted attempt timer out of its replacement attempt', async () => {
    const firstModule = deferred<EngineModule>()
    const replacementLoad = deferred<SuggestEngine>()
    const availableModules: EngineModule[] = []
    let moduleAttempt = 0
    const model = harness({
      module: (available) => {
        availableModules.push(available)
        moduleAttempt += 1
        return moduleAttempt === 1 ? firstModule.promise : Promise.resolve(available)
      },
      load: () => replacementLoad.promise,
    })
    const view = render(live(), model.deps)
    const headStart = Math.floor(SLOW_AFTER_MS / 2)

    await advance(START_GRACE_MS)
    expect(view.result.current.phase).toBe('checking')

    act(() => {
      view.result.current.pause()
    })
    expect(view.result.current.phase).toBe('cancelled')

    await advance(headStart)
    act(() => {
      view.result.current.resume()
    })
    await advance(0)
    expect(view.result.current.phase).toBe('loading')

    await advance(SLOW_AFTER_MS - headStart)
    expect(view.result.current.slow).toBe(false)

    await advance(headStart)
    expect(view.result.current.slow).toBe(true)

    replacementLoad.resolve(model.engine)
    const firstAvailable = availableModules[0]
    if (firstAvailable === undefined) {
      throw new Error('the first attempt never received the model module')
    }
    firstModule.resolve(firstAvailable)
    await advance(0)
    view.unmount()
  })

  /*
   * A cancellation the load's own bound must not later overwrite.
   *
   * The boundary is allowed to leave a cancelled load pending forever - `webllm.ts` cannot
   * stop fetches the library has already started - so the bound is still counting down
   * against work nobody is waiting for. Left alone it fires, and the visitor who stopped
   * the download minutes earlier is told the model timed out: a failure banner, and a
   * `cancelled` phase replaced by `unavailable`, about a load they had already ended.
   *
   * The clock is moved well past the bound, because the point is that the bound never
   * reports anything, rather than that it reports late.
   */
  it('keeps a cancelled load cancelled, however long its own bound would have run', async () => {
    const model = harness({ load: () => new Promise<SuggestEngine>(() => undefined) })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.phase).toBe('loading')

    act(() => {
      view.result.current.pause()
    })
    expect(view.result.current.phase).toBe('cancelled')

    await advance(INIT_TIMEOUT_MS * 2)

    expect(view.result.current.phase).toBe('cancelled')
    expect(view.result.current.failure).toBeNull()
    expect(view.result.current.progress).toBeNull()
    expect(view.result.current.slow).toBe(false)

    // And the recommender still answers, which is the whole point of the state being benign.
    act(() => {
      view.result.current.suggest(NATURE)
    })
    expect(view.result.current.answer?.source).toBe('deterministic')
  })

  it('reports a device that ran out of memory as memory, not as a failure of the page', async () => {
    const model = harness({
      load: () => Promise.reject(new RangeError('Array buffer allocation failed')),
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)

    expect(view.result.current.phase).toBe('unavailable')
    expect(view.result.current.failure?.kind).toBe('memory')
    expect(view.result.current.progress).toBeNull()
  })

  it('keeps a retryable load failure and retry action while names are shown and cleared', async () => {
    const model = harness({ load: () => Promise.reject(new Error('nothing familiar')) })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    const failure = view.result.current.failure
    expect(failure?.kind).toBe('load-failed')
    expect(failure?.retryable).toBe(true)

    act(() => {
      view.result.current.suggest(NATURE)
    })

    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.failure).toBe(failure)
    expect(view.result.current.phase).toBe('unavailable')

    act(() => {
      view.result.current.clear()
    })

    expect(view.result.current.answer).toBeNull()
    expect(view.result.current.failure).toBe(failure)
    expect(view.result.current.failure?.retryable).toBe(true)
    expect(view.result.current.phase).toBe('unavailable')

    act(() => {
      view.result.current.resume()
    })
    await advance(0)
    expect(model.calls.load).toBe(2)
  })

  /*
   * No hidden retry loop. One automatic attempt, however long the page stays open, and a
   * second one only because somebody asked for it - which is the difference between a
   * bound on what this page does by itself and a bound on what a visitor may choose.
   */
  it('makes one automatic attempt, and another only when asked', async () => {
    const model = harness({ load: () => Promise.reject(new Error('nothing familiar')) })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    expect(view.result.current.phase).toBe('unavailable')
    expect(model.calls.load).toBe(1)

    await advance(START_GRACE_MS * 10)
    expect(model.calls.load).toBe(1)

    act(() => {
      view.result.current.resume()
    })
    await advance(0)
    expect(model.calls.load).toBe(2)
  })
})

describe('answering', () => {
  it('answers before the model is loaded, and says which recommender ordered it', async () => {
    const loading = deferred<SuggestEngine>()
    const model = harness({ load: () => loading.promise })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })

    const answer = view.result.current.answer
    expect(answer?.source).toBe('deterministic')
    expect(answer?.preference).toBe(NATURE)
    expect(answer?.consideredCount).toBe(ROWS.length)
    // The ranking itself is `shortlist.test.ts`'s; what is checked here is that the hook
    // draws its fallback from that shortlist, in that order, and from nothing else.
    expect(answer?.suggestions.map((suggestion) => suggestion.name)).toEqual(
      shortlistNames(buildShortlist(ROWS, NATURE)).slice(0, answer?.suggestions.length),
    )
    expect(model.calls.generate).toBe(0)
  })

  /*
   * The deterministic answer is on screen first and the model's replaces it, so there is
   * never a moment where a visitor has asked and has nothing. The model's own order is
   * kept, because reordering is the job it was given.
   */
  it('shows the deterministic answer first and replaces it with the model’s', async () => {
    const answering = deferred<string>()
    const model = harness({ generate: () => answering.promise })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.phase).toBe('generating')

    const allowed = offered(model)
    answering.resolve(answerNaming([at(allowed, 2), at(allowed, 0)]))
    await advance(0)

    const answer = view.result.current.answer
    expect(answer?.source).toBe('model')
    expect(answer?.suggestions.map((suggestion) => suggestion.name)).toEqual([
      at(allowed, 2),
      at(allowed, 0),
    ])
    const safe = shortlistSuggestions(buildShortlist(ROWS, NATURE), NATURE)
    expect(answer?.suggestions[0]).toEqual(
      safe.find((suggestion) => suggestion.name === at(allowed, 2)),
    )
    expect(view.result.current.phase).toBe('ready')
    expect(view.result.current.failure).toBeNull()
  })

  /*
   * The rule the shortlist exists for. A plausible `.eth` name from the model's training
   * data is the dangerous case: it would render as a row with a sentence about it and this
   * page holds no record of it at all. The answer is refused whole, the deterministic one
   * stays exactly where it is, and the panel gains a sentence.
   */
  it('refuses a name it never offered and keeps the deterministic answer', async () => {
    const model = harness({
      generate: () => Promise.resolve(JSON.stringify({ picks: [{ name: 'vitalik.eth' }] })),
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    const before = view.result.current.answer
    await advance(0)

    const after = view.result.current.answer
    expect(after?.source).toBe('deterministic')
    expect(after?.suggestions).toEqual(before?.suggestions)
    expect(after?.suggestions.map((suggestion) => suggestion.name)).not.toContain('vitalik.eth')
    expect(view.result.current.failure?.kind).toBe('generate-refused')
    expect(view.result.current.phase).toBe('ready')
  })

  /*
   * A name the snapshot really holds but the visitor's filters excluded. This is the same
   * refusal and it matters just as much: the shortlist is the visitor's own scope, so a
   * name outside it is one this answer has nothing true to say about.
   */
  it('refuses a name the filters excluded, even though the snapshot holds it', async () => {
    const model = harness({
      generate: () => Promise.resolve(JSON.stringify({ picks: [{ name: 'quartz.eth' }] })),
    })
    const view = render(live(NARROWED), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)

    expect(offered(model)).not.toContain('quartz.eth')
    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.failure?.kind).toBe('generate-refused')
  })

  it('refuses an answer that is not the shape it asked for', async () => {
    const model = harness({ generate: () => Promise.resolve('Here you go: moss.eth is nice.') })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)

    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.failure?.kind).toBe('generate-refused')
  })

  it('gives up on a generation that does not answer in time', async () => {
    const model = harness({ generate: () => new Promise<string>(() => undefined) })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(GENERATE_TIMEOUT_MS)

    expect(view.result.current.failure?.kind).toBe('generate-timeout')
    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.phase).toBe('ready')
  })

  it('clears a generation failure with the answer that produced it', async () => {
    const model = harness({
      generate: () => Promise.reject(new RangeError('Array buffer allocation failed')),
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)

    expect(view.result.current.answer?.source).toBe('deterministic')
    expect(view.result.current.failure?.kind).toBe('memory')

    act(() => {
      view.result.current.clear()
    })

    expect(view.result.current.answer).toBeNull()
    expect(view.result.current.failure).toBeNull()
  })

  it('clears a stale generation failure when another answer is requested', async () => {
    const nextAnswer = deferred<string>()
    let request = 0
    const model = harness({
      generate: () => {
        request += 1
        return request === 1 ? Promise.reject(new Error('generation failed')) : nextAnswer.promise
      },
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)
    expect(view.result.current.failure?.kind).toBe('generate-failed')

    act(() => {
      view.result.current.suggest(COSMIC)
    })
    expect(view.result.current.failure).toBeNull()
    expect(view.result.current.phase).toBe('generating')

    nextAnswer.resolve(answerNaming([at(offered(model, 1), 0)]))
    await advance(0)
    expect(view.result.current.phase).toBe('ready')
  })

  it('returns to ready after clearing a generation in flight', async () => {
    const answering = deferred<string>()
    const model = harness({ generate: () => answering.promise })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    expect(view.result.current.phase).toBe('generating')

    act(() => {
      view.result.current.clear()
    })
    expect(view.result.current.answer).toBeNull()

    await advance(0)
    expect(view.result.current.phase).toBe('ready')
    expect(view.result.current.failure).toBeNull()
  })

  /*
   * A second request replaces the first rather than racing it. The first answer is
   * discarded even though it arrives well-formed, because it describes a preference the
   * visitor has already moved on from.
   */
  it('replaces a request in flight rather than racing it', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let issued = 0
    const model = harness({
      generate: () => {
        const next = answers[issued]
        issued += 1
        if (next === undefined) {
          throw new Error('the model was asked more times than this test allows')
        }
        return next.promise
      },
    })
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    act(() => {
      view.result.current.suggest(COSMIC)
    })

    answers[0]?.resolve(answerNaming([at(offered(model, 0), 0)]))
    await advance(0)
    expect(view.result.current.answer?.source).toBe('deterministic')

    answers[1]?.resolve(answerNaming([at(offered(model, 1), 0)]))
    await advance(0)

    const answer = view.result.current.answer
    expect(answer?.source).toBe('model')
    expect(answer?.preference).toBe(COSMIC)
    const safe = shortlistSuggestions(buildShortlist(ROWS, COSMIC), COSMIC)
    expect(answer?.suggestions[0]).toEqual(
      safe.find((suggestion) => suggestion.name === at(offered(model, 1), 0)),
    )
  })

  /*
   * An answer names the shortlist it was drawn from, not whatever is filtered now. A
   * visitor who narrows the list while a generation is in flight must not have the answer
   * they asked for rewritten with names they were never shown, and must not have it
   * refused for holding a name that was in scope when they asked.
   */
  it('judges an answer against the shortlist it was built from', async () => {
    const answering = deferred<string>()
    const model = harness({ generate: () => answering.promise })
    const view = render(live(ROWS), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    act(() => {
      view.rerender(live(NARROWED))
    })

    expect(offered(model)).toContain('quartz.eth')
    answering.resolve(answerNaming(['quartz.eth']))
    await advance(0)

    const answer = view.result.current.answer
    expect(answer?.source).toBe('model')
    expect(answer?.suggestions.map((suggestion) => suggestion.name)).toEqual(['quartz.eth'])
  })

  it('asks nothing of the model when the filters admit no names', async () => {
    const model = harness()
    const view = render(live([]), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)

    expect(view.result.current.answer?.suggestions).toEqual([])
    expect(view.result.current.answer?.consideredCount).toBe(0)
    expect(view.result.current.phase).toBe('ready')
    expect(model.calls.generate).toBe(0)
  })

  it('clears an answer and the sentence beside it together', async () => {
    const model = harness()
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)
    expect(view.result.current.answer?.source).toBe('model')

    act(() => {
      view.result.current.clear()
    })
    expect(view.result.current.answer).toBeNull()
    expect(view.result.current.failure).toBeNull()
  })
})

describe('what leaves the device', () => {
  /*
   * The privacy claim, checked structurally. Everything the page does with a preference, a
   * shortlist, a prompt, and a generated answer happens above the injected boundary, so a
   * whole load and a whole generation cost no request of any kind. The boundary itself is
   * the only thing that ever fetches, and `webllm.ts` is the only implementation of it.
   */
  it('makes no request while loading a model and answering with it', async () => {
    const model = harness()
    const view = render(live(), model.deps)

    await advance(START_GRACE_MS)
    act(() => {
      view.result.current.suggest(NATURE)
    })
    await advance(0)

    expect(view.result.current.answer?.source).toBe('model')
    expect(networkCalls).toBe(0)
  })
})
