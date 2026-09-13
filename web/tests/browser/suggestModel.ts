import { expect, type Page, type Request } from '@playwright/test'
import { OPT_OUT_KEY, START_GRACE_MS } from '../../src/suggest/contract'
import type { SupportVerdict } from '../../src/suggest/engine/types'

/**
 * The model boundary, as a real browser sees it.
 *
 * The production build reaches `@mlc-ai/web-llm` through exactly one dynamic import, in
 * `src/suggest/engine/load.ts`, and Vite therefore emits it as one separately fetched
 * chunk. That import is the seam these tests replace: the chunk request is fulfilled with
 * a small module of our own that satisfies `EngineModule` and nothing else, so the page
 * runs its real state machine, its real prompt builder, its real parser, and its real
 * panel against a model that never existed.
 *
 * Replacing the chunk rather than calling into a test hook is the point. There is no seam
 * in `src/` that a test opens and a visitor could reach - `assets.spec.ts` would fail on
 * one, because a hook is a name in the entry chunk - so what these tests exercise is the
 * shipped path and not a parallel one. The only two things injected from outside the page
 * are a `navigator.gpu` marker, which is all `hasWebGpu` reads, and a bridge object the
 * fake module consults.
 *
 * Nothing here downloads a model or contacts any service. `forbidModelHosts` proves that
 * rather than asserting it in prose: the real asset origins are routed to an abort, and
 * `expectNoModelHostAttempts` fails the test that reached one.
 */

/** What the fake module should do. Mutable from a test through `setPlan`. */
export interface ModelPlan {
  /** The verdict `probeSupport` returns. */
  readonly probe: SupportVerdict
  /** What `isCached` reports, which is what words the size notice. */
  readonly cached: boolean
  /** True to resolve the load as soon as it is asked for, without a step from the test. */
  readonly autoLoad: boolean
  /** The raw text one generation returns, or null to hold it until the test decides. */
  readonly answer: string | null
}

const DEFAULT_PLAN: ModelPlan = { probe: 'ok', cached: false, autoLoad: true, answer: null }

/**
 * The bridge the fake module and the test share, on the page.
 *
 * Declared as a type on a cast rather than as a global augmentation of `Window`. An
 * augmentation would put the property on the `window` every file in `src/` sees, which is
 * exactly the kind of test-only seam the production code is not supposed to have - even a
 * type-only one, because the next person to need it would find it already declared.
 */
interface FakeBridge {
  plan: ModelPlan
  readonly events: string[]
  readonly prompts: RecordedPrompt[]
  report: ((fraction: number | null, text: string) => void) | null
  finishLoad: (() => void) | null
  failLoad: ((message: string) => void) | null
  finishGenerate: ((text: string) => void) | null
  failGenerate: ((message: string) => void) | null
}

/** The page's `window`, with the bridge on it. Used only inside `page.evaluate`. */
interface FakeWindow extends Window {
  __ensSuggestFake: FakeBridge
}

/** One recorded request to the model, with the exact list it was shown. */
export interface RecordedPrompt {
  readonly system: string
  readonly user: string
  readonly allowed: readonly string[]
  readonly schema: Record<string, unknown>
}

/**
 * The fake chunk.
 *
 * Written as one string rather than compiled from `src/`, for the reason
 * `tests/browser/checkApi.ts` builds its check documents by hand: a fake the production
 * code helped construct agrees with the production code by construction, and half of what
 * is under test here is the page refusing an answer.
 *
 * Every load and every generation is a promise a test resolves, so no test waits on a real
 * interval to observe a state that exists only while work is in flight. The plan is read
 * on each call rather than captured, so a test can change it between attempts.
 */
const FAKE_MODULE = `
const bridge = window.__ensSuggestFake

function engine() {
  return {
    generate: (prompt, signal) => {
      bridge.events.push('generate')
      // Recorded whole, because what may be sent to a model is the assertion: the
      // shortlist it was shown, the schema that bounds it, and the two messages.
      bridge.prompts.push({
        system: prompt.system,
        user: prompt.user,
        allowed: [...prompt.allowed],
        schema: prompt.schema,
      })
      signal.addEventListener('abort', () => { bridge.events.push('generate-abort') })
      return new Promise((resolve, reject) => {
        bridge.finishGenerate = (text) => { resolve(text) }
        bridge.failGenerate = (message) => { reject(new Error(message)) }
        if (bridge.plan.answer !== null) { resolve(bridge.plan.answer) }
      })
    },
    dispose: () => {
      bridge.events.push('dispose')
      return Promise.resolve()
    },
  }
}

export default {
  probeSupport: () => {
    bridge.events.push('probe')
    return Promise.resolve(bridge.plan.probe)
  },
  isCached: () => {
    bridge.events.push('isCached')
    return Promise.resolve(bridge.plan.cached)
  },
  loadEngine: (request) => {
    bridge.events.push('load')
    bridge.report = (fraction, text) => { request.onProgress({ fraction, text }) }
    request.signal.addEventListener('abort', () => { bridge.events.push('load-abort') })
    return new Promise((resolve, reject) => {
      bridge.finishLoad = () => { resolve(engine()) }
      bridge.failLoad = (message) => { reject(new Error(message)) }
      if (bridge.plan.autoLoad) { resolve(engine()) }
    })
  },
}
`

/**
 * The asset origins the pinned configuration names, and the library's own catalogue host.
 *
 * Routed to an abort in every test, so a build that reached one - or a harness that failed
 * to intercept the chunk and let the real library run - fails the test that did it rather
 * than quietly succeeding against the network. This is the privacy guarantee as a check
 * rather than as a claim, and it is the reason no test here can download a model even if
 * the interception broke.
 */
const MODEL_HOST_GLOBS = [
  'https://huggingface.co/**',
  'https://*.huggingface.co/**',
  'https://*.hf.co/**',
  'https://raw.githubusercontent.com/**',
] as const

/** Requests to a model host that were attempted. Empty in every passing run. */
export interface HostWatch {
  readonly attempts: readonly string[]
}

/** Refuses every request to a model asset host and records it. */
export async function forbidModelHosts(page: Page): Promise<HostWatch> {
  const attempts: string[] = []
  for (const glob of MODEL_HOST_GLOBS) {
    await page.route(glob, async (route) => {
      attempts.push(route.request().url())
      await route.abort()
    })
  }
  return { attempts }
}

/** The assertion the watch exists for. Called by every test that loads a model. */
export function expectNoModelHostAttempts(watch: HostWatch): void {
  expect(watch.attempts, 'a model asset host was contacted').toEqual([])
}

export interface InstallOptions {
  /** Overrides on the default plan. */
  readonly plan?: Partial<ModelPlan>
  /** False to leave `navigator.gpu` absent, which is the unsupported-device path. */
  readonly webgpu?: boolean
  /** Written to the opt-out key before the page loads, for the returning-visitor path. */
  readonly optedOut?: boolean
  /** `navigator.onLine`, which chooses between two sentences about a failed fetch. */
  readonly online?: boolean
}

/**
 * Installs the fake boundary and the plan.
 *
 * Called before the navigation, because the chunk route and the init script both have to
 * be in place before any of the page's own code runs.
 */
export async function installFakeModel(
  page: Page,
  options: InstallOptions = {},
): Promise<HostWatch> {
  const watch = await forbidModelHosts(page)
  const plan: ModelPlan = { ...DEFAULT_PLAN, ...options.plan }

  /*
   * The bridge, and the two pieces of the platform the page reads directly.
   *
   * `navigator.gpu` is a bare marker because `hasWebGpu` only asks whether the property is
   * there; the verdict a real adapter would give comes from the fake's own `probeSupport`,
   * which is where a device refusal belongs. Headless Chromium exposes no WebGPU at all,
   * so without this marker every test here would take the unsupported path - which is also
   * why the unsupported test simply omits it rather than removing anything.
   */
  await page.addInitScript(
    (setup: {
      readonly plan: ModelPlan
      readonly webgpu: boolean
      readonly online: boolean | undefined
      readonly optOutKey: string | null
    }) => {
      const bridge: FakeBridge = {
        plan: setup.plan,
        events: [],
        prompts: [],
        report: null,
        finishLoad: null,
        failLoad: null,
        finishGenerate: null,
        failGenerate: null,
      }
      Object.defineProperty(window, '__ensSuggestFake', { value: bridge, configurable: true })
      if (setup.webgpu) {
        Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
      }
      if (setup.online === false) {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      }
      if (setup.optOutKey !== null) {
        window.localStorage.setItem(setup.optOutKey, 'off')
      }
    },
    {
      plan,
      webgpu: options.webgpu !== false,
      online: options.online,
      // The real key, from the real constant, so a rename cannot leave this writing an
      // entry nothing reads and the test passing for the wrong reason.
      optOutKey: options.optedOut === true ? OPT_OUT_KEY : null,
    },
  )

  // The one dynamic import in the build. The hash varies per build, so the name is matched
  // rather than pinned; `assets.spec.ts` asserts the same shape from the other side, so a
  // rename breaks both rather than silently widening either.
  await page.route('**/assets/webllm-*.js', async (route) => {
    await route.fulfill({ body: FAKE_MODULE, headers: { 'content-type': 'text/javascript' } })
  })

  return watch
}

/** Whether a request is for the model chunk, so a test can see whether it was fetched. */
export function isModelChunk(request: Request): boolean {
  return /\/assets\/webllm-[^/]+\.js$/.test(new URL(request.url()).pathname)
}

/** What the fake was asked to do, in order. */
export function events(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...(window as unknown as FakeWindow).__ensSuggestFake.events])
}

/** Every prompt the model was given, which is the whole of what could have been sent. */
export function prompts(page: Page): Promise<readonly RecordedPrompt[]> {
  return page.evaluate(
    () =>
      JSON.parse(
        JSON.stringify((window as unknown as FakeWindow).__ensSuggestFake.prompts),
      ) as RecordedPrompt[],
  )
}

/** Changes the plan mid-page, for a second attempt that should behave differently. */
export function setPlan(page: Page, changes: Partial<ModelPlan>): Promise<void> {
  return page.evaluate((next: Partial<ModelPlan>) => {
    Object.assign((window as unknown as FakeWindow).__ensSuggestFake.plan, next)
  }, changes)
}

/** Emits one progress report from inside the load the page is waiting on. */
export function report(page: Page, fraction: number | null, text: string): Promise<void> {
  return page.evaluate(
    (step: { readonly fraction: number | null; readonly text: string }) => {
      ;(window as unknown as FakeWindow).__ensSuggestFake.report?.(step.fraction, step.text)
    },
    { fraction, text },
  )
}

/** Resolves the held load. */
export function finishLoad(page: Page): Promise<void> {
  return page.evaluate(() => {
    ;(window as unknown as FakeWindow).__ensSuggestFake.finishLoad?.()
  })
}

/** Rejects the held load with a message the page must classify and must not show. */
export function failLoad(page: Page, message: string): Promise<void> {
  return page.evaluate((text: string) => {
    ;(window as unknown as FakeWindow).__ensSuggestFake.failLoad?.(text)
  }, message)
}

/** Resolves the held generation with raw text the page has to parse or refuse. */
export function finishGenerate(page: Page, text: string): Promise<void> {
  return page.evaluate((body: string) => {
    ;(window as unknown as FakeWindow).__ensSuggestFake.finishGenerate?.(body)
  }, text)
}

/** Rejects the held generation. */
export function failGenerate(page: Page, message: string): Promise<void> {
  return page.evaluate((text: string) => {
    ;(window as unknown as FakeWindow).__ensSuggestFake.failGenerate?.(text)
  }, message)
}

/**
 * Steps the clock past the window in which nothing is fetched.
 *
 * A little over the grace, so the timer has certainly fired. Every test that wants a load
 * to begin calls this, which is also what makes the deferral assertion meaningful: before
 * this call the page has had every opportunity to start and has not.
 */
export function passGrace(page: Page): Promise<void> {
  return page.clock.fastForward(START_GRACE_MS + 500)
}

/**
 * A well-formed answer naming the given names.
 *
 * Built here rather than by importing anything from `src/`, so the document under test is
 * one a model could have produced and not one this build helped shape.
 */
export function answerNaming(...names: readonly string[]): string {
  return JSON.stringify({
    picks: names.map((name) => ({ name })),
  })
}

/** The panel's own status line, which is where every phase is stated. */
export async function expectModelLine(page: Page, pattern: RegExp): Promise<void> {
  await expect(page.locator('.suggest__state')).toHaveText(pattern)
}
