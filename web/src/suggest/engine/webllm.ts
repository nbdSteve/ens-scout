import {
  CreateMLCEngine,
  hasModelInCache,
  type AppConfig,
  type MLCEngine,
  type ModelRecord,
} from '@mlc-ai/web-llm'
import { GENERATION_MAX_TOKENS, MODEL_ID, MODEL_REQUIRED_FEATURE } from '../contract'
import type { SuggestPrompt } from '../prompt'
import type {
  EngineModule,
  LoadProgress,
  LoadRequest,
  SuggestEngine,
  SupportVerdict,
} from './types'

/**
 * The only file in this repository that imports `@mlc-ai/web-llm`.
 *
 * It is reached through a dynamic import in `load.ts` and nowhere else, so the library
 * and the asset URLs below land in a chunk the core page never requests.
 * `tests/browser/assets.spec.ts` asserts both halves of that: the entry chunk names no
 * model host, and the model chunk names only these three.
 *
 * The model list is pinned here as one explicit record rather than taken from
 * `prebuiltAppConfig`. Two reasons, and the second is the important one. A one-record
 * config means the library cannot be asked for any other model, so there is no code
 * path - and no bug - that reaches a second one. And it puts every URL this feature can
 * fetch in one place a reader can see, which is what makes "assets download only through
 * the pinned configuration" a fact about the source rather than a claim about intent.
 * `contract.drift.test.ts` compares the record field by field against the library's own,
 * so a version bump that moved the weights or changed the requirements fails a test.
 *
 * Nothing a visitor types or chooses reaches any of this. The prompt is built above,
 * the record is fixed, and there is no parameter anywhere here that could name a URL.
 */

/**
 * The pinned model record.
 *
 * `model` is the weights and the tokenizer, `model_lib` is the compiled shader library.
 * The `model_lib` path carries the library's own version segment, which is why it is
 * pinned alongside the npm version rather than derived: a bump changes it, and a mismatch
 * is a load failure on a visitor's device rather than a build error.
 */
export const PINNED_MODEL: ModelRecord = {
  model: 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC',
  model_id: MODEL_ID,
  model_lib:
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm',
  vram_required_MB: 376.06,
  low_resource_required: true,
  required_features: [MODEL_REQUIRED_FEATURE],
  overrides: { context_window_size: 4096 },
}

/**
 * The whole configuration. One model, and the Cache API - which is the library's own
 * default and the backend its own documentation calls the best tested. It is stated
 * rather than left implicit because it is what makes a second visit free, and
 * `web/README.md` describes that behaviour to a reader who has to trust it.
 */
export const APP_CONFIG: AppConfig = { model_list: [PINNED_MODEL], cacheBackend: 'cache' }

/**
 * Temperature and the top-p bound for a request whose whole output shape is fixed by a
 * grammar. Low, not zero: the choice among a shortlist is the one thing worth varying,
 * so two visitors asking the same thing are not guaranteed the same five names, while
 * the wording stays close to the list rather than wandering.
 */
const TEMPERATURE = 0.4
const TOP_P = 0.9

/*
 * The three members of WebGPU this file asks about.
 *
 * Declared here rather than taken from `@webgpu/types`, because these three are all that
 * is used and the package is neither a dependency of the library nor small. Declared
 * locally rather than merged into the global `Navigator`, which is the important half: a
 * global augmentation would collide the day TypeScript's own DOM library gains `gpu`,
 * and a cast at the one site that needs it cannot.
 *
 * `features` is a set of strings by specification, so a feature name is checked against
 * what the adapter reports rather than against a list this file believes in.
 */
interface WebGpuAdapter {
  readonly features: ReadonlySet<string>
}

interface WebGpu {
  readonly requestAdapter: () => Promise<WebGpuAdapter | null>
}

/**
 * Whether this device can run the pinned model.
 *
 * Asked of the adapter rather than inferred from a user agent string. The feature check
 * is separate from the WebGPU check because the two are different messages: a browser
 * with no WebGPU is out of date or has it turned off, and an adapter without `shader-f16`
 * is a device that will never run this model however new the browser is.
 *
 * `requestAdapter` resolves with null on a device it cannot serve rather than rejecting,
 * so the null case is the ordinary unsupported one and a rejection is the probe itself
 * failing.
 */
async function probeSupport(): Promise<SupportVerdict> {
  const gpu = (navigator as { gpu?: WebGpu }).gpu
  if (gpu === undefined) {
    return 'no-webgpu'
  }
  try {
    const adapter = await gpu.requestAdapter()
    if (adapter === null) {
      return 'no-webgpu'
    }
    return adapter.features.has(MODEL_REQUIRED_FEATURE) ? 'ok' : 'no-feature'
  } catch {
    return 'probe-failed'
  }
}

/**
 * Whether the assets are already in this browser's cache.
 *
 * Used only to word the notice: a returning visitor is told the model is already stored
 * rather than being quoted a download size they will not pay. A store that will not
 * answer is reported as not cached, which is the cautious direction - the visitor is
 * told the size, and then the load turns out to be instant.
 */
async function isCached(): Promise<boolean> {
  try {
    return await hasModelInCache(MODEL_ID, APP_CONFIG)
  } catch {
    return false
  }
}

function reportProgress(onProgress: (progress: LoadProgress) => void) {
  return (report: { progress: number; text: string }): void => {
    // The library reports progress per phase and restarts it between phases, so it is
    // passed through as given. A value outside [0, 1] is reported as no value at all
    // rather than clamped, because a bar pinned at one end says something untrue.
    const fraction = report.progress >= 0 && report.progress <= 1 ? report.progress : null
    onProgress({ fraction, text: report.text })
  }
}

/**
 * Loads the model, or rejects.
 *
 * The abort is handled around the library rather than inside it: `CreateMLCEngine` takes
 * no signal, so a cancelled load is one whose engine is unloaded the moment it arrives.
 * That is the honest bound on what cancellation can do here - the fetches already in
 * flight are the library's, and it exposes no way to stop them - and it is what
 * `web/README.md` records as the limit. What it does guarantee is that a cancelled load
 * holds no GPU memory and answers nothing.
 */
async function loadEngine(request: LoadRequest): Promise<SuggestEngine> {
  const engine: MLCEngine = await CreateMLCEngine(MODEL_ID, {
    appConfig: APP_CONFIG,
    initProgressCallback: reportProgress(request.onProgress),
  })
  if (request.signal.aborted) {
    await unload(engine)
    throw request.signal.reason instanceof Error
      ? request.signal.reason
      : new Error('the load was cancelled')
  }
  return wrap(engine)
}

async function unload(engine: MLCEngine): Promise<void> {
  try {
    await engine.unload()
  } catch {
    // Disposal is best effort by contract. A library that will not unload is not a
    // reason to fail the path that was already giving the model up.
  }
}

function wrap(engine: MLCEngine): SuggestEngine {
  let disposed = false
  return {
    generate: async (prompt: SuggestPrompt, signal: AbortSignal): Promise<string> => {
      if (disposed) {
        throw new Error('the model was released')
      }
      // Interrupting is what the library offers instead of a signal. It is registered
      // before the request so an abort that arrives during decoding is acted on, and
      // removed afterwards so it cannot outlive this call.
      const interrupt = (): void => {
        void engine.interruptGenerate()
      }
      signal.addEventListener('abort', interrupt, { once: true })
      try {
        const completion = await engine.chat.completions.create({
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          // The grammar. `json_object` with a schema is what constrains decoding to the
          // one document shape, which is how the name field becomes a choice from the
          // shortlist rather than free text. `parse.ts` checks it again regardless.
          response_format: { type: 'json_object', schema: JSON.stringify(prompt.schema) },
          max_tokens: GENERATION_MAX_TOKENS,
          temperature: TEMPERATURE,
          top_p: TOP_P,
          n: 1,
          stream: false,
        })
        if (signal.aborted) {
          // An interrupted generation resolves with whatever it had. Rejecting is what
          // keeps a cancelled request from being read as a refusable answer.
          throw new Error('the generation was cancelled')
        }
        return completion.choices[0]?.message.content ?? ''
      } finally {
        signal.removeEventListener('abort', interrupt)
      }
    },
    dispose: async (): Promise<void> => {
      if (disposed) {
        return
      }
      disposed = true
      await unload(engine)
    },
  }
}

/** The module `load.ts` resolves to. */
const module: EngineModule = { probeSupport, loadEngine, isCached }
export default module
