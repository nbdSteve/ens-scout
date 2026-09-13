import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GENERATE_TIMEOUT_MS,
  INIT_MAX_ATTEMPTS,
  INIT_TIMEOUT_MS,
  SLOW_AFTER_MS,
  START_GRACE_MS,
} from '../suggest/contract'
import { hasWebGpu as realHasWebGpu, loadEngineModule } from '../suggest/engine/load'
import type { EngineModule, LoadProgress, SuggestEngine } from '../suggest/engine/types'
import {
  describeGenerateFailure,
  describeLoadFailure,
  describeSupport,
  SuggestTimeoutError,
  type SuggestFailure,
} from '../suggest/failure'
import { localOptOut, type OptOutStore } from '../suggest/optOut'
import { parseSuggestions } from '../suggest/parse'
import { buildPrompt } from '../suggest/prompt'
import {
  buildShortlist,
  deterministicSuggestions,
  shortlistSuggestions,
  type Suggestion,
} from '../suggest/shortlist'
import type { Preference } from '../suggest/vibes'
import type { SnapshotResult } from '../snapshot/types'
import { getLocalStorage } from '../data/cache'

/**
 * The optional model, and the recommender that does not need it.
 *
 * Four rules shape all of it.
 *
 * The names come first, always. Nothing here runs until the page is interactive and the
 * snapshot is on screen, and then it still waits, because the download is large enough
 * that a visitor has to be able to stop it before it starts rather than discover it
 * afterwards. Until it is loaded - and if it never loads - the deterministic recommender
 * is the recommender, and it is a real answer rather than a placeholder.
 *
 * Every failure is a state on the panel, never an application error. An unsupported
 * device, a blocked asset, a device that ran out of memory, a load that took too long,
 * and an answer this build refused are five different sentences and none of them stops
 * the page working. That is why `suggest` never rejects: it always leaves an answer.
 *
 * Nothing retries itself. `INIT_MAX_ATTEMPTS` automatic attempts, and after that a
 * failure is offered back as a button, so bandwidth is spent because somebody asked. The
 * bounds are all in `suggest/contract.ts` and every one of them is a ceiling on work a
 * device does or a wait a visitor sits through.
 *
 * A visitor's no is durable. Pausing is for this page, disabling is remembered on this
 * device, and the difference is stated to them rather than inferred.
 */

export type SuggestPhase =
  /** Interactive, nothing fetched, the size notice and the controls on screen. */
  | 'waiting'
  /** Asking the device whether it could run the model. */
  | 'checking'
  /** Fetching the model. */
  | 'loading'
  /** Loaded and idle. */
  | 'ready'
  /** One generation in flight. */
  | 'generating'
  /** Stopped by the visitor before anything was fetched. This page only. */
  | 'paused'
  /** Stopped by the visitor part way through a load. This page only. */
  | 'cancelled'
  /** Turned off by the visitor, and remembered on this device. */
  | 'disabled'
  /** The model will not be used on this device or in this session. `failure` says why. */
  | 'unavailable'

/** One answer, and which recommender chose its order. */
export interface SuggestAnswer {
  readonly preference: Preference
  readonly suggestions: readonly Suggestion[]
  /**
   * Which recommender chose the order. Every explanation is repository-owned regardless.
   */
  readonly source: 'model' | 'deterministic'
  /** How many names were in scope before the shortlist was cut to its bound. */
  readonly consideredCount: number
}

export interface SuggestCapabilities {
  readonly pause: boolean
  readonly resume: boolean
  readonly disable: boolean
  readonly enable: boolean
}

export interface SuggestStore {
  readonly phase: SuggestPhase
  /** How far the load has got, or null when nothing is loading. */
  readonly progress: LoadProgress | null
  /** True while a load has run past the point where saying so is the honest thing. */
  readonly slow: boolean
  /** The most recent failure of either kind, or null. Kept while an answer is shown. */
  readonly failure: SuggestFailure | null
  /** True once the model is known to be stored on this device already. */
  readonly cached: boolean
  readonly answer: SuggestAnswer | null
  readonly capabilities: SuggestCapabilities
  /** Stops a load or declines to start one, for this page only. */
  readonly pause: () => void
  /** Starts, or restarts, after a pause, a cancellation, or a retryable failure. */
  readonly resume: () => void
  /** Stops it and remembers the decision on this device. */
  readonly disable: () => void
  /** Undoes `disable`. Does not itself begin a load; `resume` does that. */
  readonly enable: () => void
  readonly suggest: (preference: Preference) => void
  readonly clear: () => void
}

/** Injected for tests. Defaults to the real seam and the real store. */
export interface SuggestDeps {
  readonly hasWebGpu?: () => boolean
  readonly loadModule?: () => Promise<EngineModule>
  readonly optOut?: OptOutStore
}

export interface SuggestInput {
  /**
   * True once the core page is interactive: the snapshot is parsed, the rows are
   * rendered, and the filters and the fresh-check action work. Nothing model-related
   * happens before this is true.
   */
  readonly interactive: boolean
  /**
   * The rows the visitor's own filters admit. The shortlist is drawn from these, so it
   * narrows what they chose rather than reaching past it.
   */
  readonly results: readonly SnapshotResult[]
}

/**
 * Whether a run has been cancelled.
 *
 * A call rather than a direct read of `signal.aborted`, and the indirection is load-bearing.
 * TypeScript models that property as immutable, so it narrows every check after the first
 * one in the same scope to `false` and the later ones are reported as dead code. They are
 * not dead: an abort arrives from outside this function, during exactly the awaits those
 * checks sit between. Reading it through a call is what keeps each check honest.
 */
function cancelled(controller: AbortController): boolean {
  return controller.signal.aborted
}

function canPause(phase: SuggestPhase): boolean {
  return (
    phase === 'waiting' ||
    phase === 'checking' ||
    phase === 'loading' ||
    phase === 'ready' ||
    phase === 'generating'
  )
}

function canResume(phase: SuggestPhase, failure: SuggestFailure | null): boolean {
  return (
    phase === 'paused' ||
    phase === 'cancelled' ||
    (phase === 'unavailable' && failure?.retryable === true)
  )
}

/**
 * Runs a promise against a bound, and reports reaching the bound as its own failure.
 *
 * The controller is aborted first, so the work is asked to stop before the caller is
 * told it timed out. Whether it can stop is the boundary's business; `webllm.ts` says
 * what it can and cannot do.
 *
 * An abort from anywhere else settles this at once, with that abort's own reason, and that
 * is what keeps a cancellation a cancellation. The boundary is free to leave a cancelled
 * promise pending - the library exposes no way to stop fetches it has already started - so
 * without this the bound would go on counting down against work nobody is waiting for, and
 * would then fire and report a timeout over the phase the visitor chose minutes earlier.
 * Rejecting with the abort's reason rather than resolving is what lets the caller tell the
 * two apart: a `SuggestTimeoutError` is this bound being reached, and anything else is
 * somebody having already decided.
 */
async function withBound<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new SuggestTimeoutError(message))
      reject(new SuggestTimeoutError(message))
    }, ms)
    onAbort = (): void => {
      const reason: unknown = controller.signal.reason
      reject(reason instanceof Error ? reason : new Error('the work was cancelled'))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, bound])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) {
      controller.signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Disposes of an engine that arrives after nobody is waiting for it.
 *
 * A cancelled or timed-out load is not a stopped load: `webllm.ts` says plainly that the
 * fetches already in flight are the library's and it exposes no way to stop them, so the
 * honest bound on cancellation is that whatever arrives is released rather than kept. That
 * has to be attached to the promise, because the caller that was awaiting it has by then
 * been rejected and cannot see what it eventually produced.
 *
 * The rejection is swallowed on purpose. A load that fails after being abandoned has
 * nothing left to report to anybody, and an unhandled rejection would be noise about work
 * the page had already given up on.
 */
function releaseIfAbandoned(loading: Promise<SuggestEngine>, controller: AbortController): void {
  void loading.then(
    (engine) => {
      if (controller.signal.aborted) {
        void engine.dispose()
      }
    },
    () => undefined,
  )
}

export function useSuggest(input: SuggestInput, deps: SuggestDeps = {}): SuggestStore {
  const { hasWebGpu = realHasWebGpu, loadModule = loadEngineModule } = deps
  // Resolved once. A store built per render would sweep the obsolete keys on every one.
  const [store] = useState<OptOutStore>(() => deps.optOut ?? localOptOut(getLocalStorage()))

  const [phase, setPhase] = useState<SuggestPhase>(() => (store.read() ? 'disabled' : 'waiting'))
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [slow, setSlow] = useState(false)
  const [failure, setFailure] = useState<SuggestFailure | null>(null)
  const [cached, setCached] = useState(false)
  const [answer, setAnswer] = useState<SuggestAnswer | null>(null)

  /*
   * The current filtered rows, read at the moment a visitor asks rather than tracked as a
   * dependency. An answer names the shortlist it was drawn from, so a later filter change
   * must not rewrite an answer that is already on screen with names it was never asked
   * about.
   *
   * Synced in an effect rather than during render. Writing a ref while rendering is a real
   * hazard and the lint rule against it is right; it is also unnecessary here, because the
   * only reader is `suggest`, which runs from an event handler and therefore always after
   * the last commit and its effects.
   */
  const results = useRef(input.results)
  useEffect(() => {
    results.current = input.results
  }, [input.results])

  const engine = useRef<SuggestEngine | null>(null)
  const loadRun = useRef<AbortController | null>(null)
  const generateRun = useRef<AbortController | null>(null)
  const attempts = useRef(0)
  /** Set when the visitor asked for this attempt, which is what lets it exceed the automatic bound. */
  const asked = useRef(false)

  const useDeterministicAnswer = useCallback(() => {
    setAnswer((current) => {
      if (current === null || current.source === 'deterministic') {
        return current
      }
      const shortlist = buildShortlist(results.current, current.preference)
      return {
        preference: current.preference,
        suggestions: deterministicSuggestions(shortlist, current.preference),
        source: 'deterministic',
        consideredCount: shortlist.consideredCount,
      }
    })
  }, [])

  const release = useCallback(() => {
    loadRun.current?.abort(new Error('the load was cancelled'))
    loadRun.current = null
    generateRun.current?.abort(new Error('the generation was cancelled'))
    generateRun.current = null
    const held = engine.current
    engine.current = null
    void held?.dispose()
    setProgress(null)
    setSlow(false)
  }, [])

  // A model held when the page goes away is released. Nothing here outlives the page.
  useEffect(
    () => () => {
      release()
    },
    [release],
  )

  /**
   * One attempt: probe the device, fetch the chunk, load the model.
   *
   * Ordered so the cheapest refusal costs the least. A browser with no WebGPU is
   * refused before the chunk is fetched, so an unsupported device downloads neither the
   * library nor a byte of the model.
   */
  const attempt = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    loadRun.current = controller
    attempts.current += 1
    setFailure(null)
    setSlow(false)
    setPhase('checking')

    const slowTimer = setTimeout(() => {
      if (!cancelled(controller) && loadRun.current === controller) {
        setSlow(true)
      }
    }, SLOW_AFTER_MS)
    const stopSlowTimer = (): void => {
      clearTimeout(slowTimer)
    }
    controller.signal.addEventListener('abort', stopSlowTimer, { once: true })

    try {
      if (!hasWebGpu()) {
        const verdict = describeSupport('no-webgpu')
        setFailure(verdict)
        setPhase('unavailable')
        return
      }
      const module = await loadModule()
      if (cancelled(controller)) {
        return
      }
      const support = await module.probeSupport()
      if (cancelled(controller)) {
        return
      }
      const refusal = describeSupport(support)
      if (refusal !== null) {
        setFailure(refusal)
        setPhase('unavailable')
        return
      }

      const stored = await module.isCached()
      if (cancelled(controller)) {
        return
      }
      setCached(stored)
      setPhase('loading')
      setProgress({ fraction: 0, text: 'Starting' })

      /*
       * The load, and the promise that owns whatever it produces.
       *
       * Held in its own variable because `withBound` may stop waiting on it - on this
       * bound, or on an abort from anywhere - while the boundary is still working. The
       * library exposes no way to stop fetches it has already started, so a cancelled load
       * can still resolve with a real engine minutes later, and that engine holds GPU
       * memory. `releaseIfAbandoned` is what guarantees it is given up: whoever stopped
       * waiting is no longer in a position to dispose of it, so the disposal is attached
       * here, to the promise itself, rather than left to the code that awaited it.
       */
      const loading = module.loadEngine({
        onProgress: (report) => {
          if (!cancelled(controller)) {
            setProgress(report)
          }
        },
        signal: controller.signal,
      })
      releaseIfAbandoned(loading, controller)

      const loaded = await withBound(
        loading,
        INIT_TIMEOUT_MS,
        controller,
        'the model did not finish loading in time',
      )
      if (cancelled(controller)) {
        // `releaseIfAbandoned` owns the disposal, so this only has to stop adopting it. The
        // two cannot both dispose: `dispose` is idempotent by contract, but the ownership
        // is what matters, and after an abort it belongs to that handler alone.
        return
      }
      engine.current = loaded
      setProgress(null)
      setSlow(false)
      setPhase('ready')
      // A completed load proves the assets are stored, whatever the earlier probe said.
      setCached(true)
    } catch (cause) {
      if (cancelled(controller) && !(cause instanceof SuggestTimeoutError)) {
        // Cancelled, not failed. The phase was already set by whoever cancelled.
        return
      }
      setProgress(null)
      setFailure(describeLoadFailure(cause))
      setPhase('unavailable')
    } finally {
      stopSlowTimer()
      controller.signal.removeEventListener('abort', stopSlowTimer)
      if (loadRun.current === controller) {
        loadRun.current = null
      }
    }
  }, [hasWebGpu, loadModule])

  /*
   * The one place a load ever begins on its own.
   *
   * Two gates, and the grace between them is the point rather than a tuning knob: the
   * page has to be interactive, and then the size notice and the pause and disable
   * controls have to have been on screen long enough to be used, with nothing yet in
   * flight. A visitor who does nothing gets the model; a visitor who says no in that
   * window is never charged for it.
   *
   * The grace is skipped for an attempt the visitor asked for, because it exists only to
   * make an unasked download refusable. Somebody who has just pressed the button has
   * already made that decision, and making them wait it out again would be describing the
   * implementation rather than honouring the choice. Still a timer rather than a direct
   * call: the load must begin after this commit, not during it.
   */
  useEffect(() => {
    if (!input.interactive || phase !== 'waiting') {
      return
    }
    if (attempts.current >= INIT_MAX_ATTEMPTS && !asked.current) {
      return
    }
    const timer = setTimeout(
      () => {
        void attempt()
      },
      asked.current ? 0 : START_GRACE_MS,
    )
    return () => {
      clearTimeout(timer)
    }
  }, [input.interactive, phase, attempt])

  const pause = useCallback(() => {
    if (!canPause(phase)) {
      return
    }
    const loading = loadRun.current !== null
    useDeterministicAnswer()
    release()
    setFailure(null)
    setPhase(loading ? 'cancelled' : 'paused')
  }, [phase, release, useDeterministicAnswer])

  const disable = useCallback(() => {
    if (phase === 'disabled') {
      return
    }
    useDeterministicAnswer()
    release()
    store.set(true)
    setFailure(null)
    setPhase('disabled')
  }, [phase, release, store, useDeterministicAnswer])

  const enable = useCallback(() => {
    if (phase !== 'disabled') {
      return
    }
    store.set(false)
    setPhase('paused')
  }, [phase, store])

  /**
   * Starts an attempt the visitor asked for.
   *
   * `asked` is what lets this exceed `INIT_MAX_ATTEMPTS`. The bound is on attempts this
   * page makes by itself, not on what somebody chooses to do, and the difference is the
   * whole reason there is no hidden retry loop.
   */
  const resume = useCallback(() => {
    if (!canResume(phase, failure)) {
      return
    }
    if (engine.current !== null) {
      setPhase('ready')
      return
    }
    store.set(false)
    asked.current = true
    setPhase('waiting')
  }, [failure, phase, store])

  /**
   * Answers, always.
   *
   * The deterministic answer is produced first and shown immediately, so there is never a
   * moment where a visitor has asked and has nothing. When the model is ready it is then
   * asked to reorder the same shortlist, and its answer replaces the deterministic order
   * only once `parse.ts` has accepted it. The displayed explanations still come from the
   * deterministic scoring evidence.
   */
  const suggest = useCallback((preference: Preference) => {
    const shortlist = buildShortlist(results.current, preference)
    const fallback: SuggestAnswer = {
      preference,
      suggestions: deterministicSuggestions(shortlist, preference),
      source: 'deterministic',
      consideredCount: shortlist.consideredCount,
    }
    setAnswer(fallback)

    const held = engine.current
    if (held !== null) {
      setFailure(null)
    }
    if (held === null || shortlist.candidates.length === 0) {
      return
    }

    // A second request replaces the first rather than racing it.
    generateRun.current?.abort(new Error('the generation was cancelled'))
    const controller = new AbortController()
    generateRun.current = controller
    setPhase('generating')

    void (async (): Promise<void> => {
      const prompt = buildPrompt(shortlist, preference)
      try {
        const text = await withBound(
          held.generate(prompt, controller.signal),
          GENERATE_TIMEOUT_MS,
          controller,
          'the model did not answer in time',
        )
        if (cancelled(controller)) {
          return
        }
        // The shortlist this call was built from, never anything read out of the
        // answer. A name outside it is refused whole rather than dropped.
        const picks = parseSuggestions(text, shortlistSuggestions(shortlist, preference))
        setAnswer({
          preference,
          suggestions: picks,
          source: 'model',
          consideredCount: shortlist.consideredCount,
        })
      } catch (cause) {
        if (cancelled(controller) && !(cause instanceof SuggestTimeoutError)) {
          return
        }
        // The deterministic answer stays on screen. Nothing from the refused text is
        // used, and nothing about it is quoted.
        setFailure(describeGenerateFailure(cause))
      } finally {
        if (generateRun.current === controller) {
          generateRun.current = null
          setPhase(engine.current === null ? 'unavailable' : 'ready')
        }
      }
    })()
  }, [])

  const clear = useCallback(() => {
    generateRun.current?.abort(new Error('the generation was cancelled'))
    setAnswer(null)
    setFailure((current) => (current?.stage === 'generation' ? null : current))
  }, [])

  const capabilities: SuggestCapabilities = {
    pause: canPause(phase),
    resume: canResume(phase, failure),
    disable: phase !== 'disabled',
    enable: phase === 'disabled',
  }

  return {
    phase,
    progress,
    slow,
    failure,
    cached,
    answer,
    capabilities,
    pause,
    resume,
    disable,
    enable,
    suggest,
    clear,
  }
}
