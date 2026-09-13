import type { SuggestPrompt } from '../prompt'

/**
 * The model boundary.
 *
 * Everything above this file is ordinary code: a shortlist, a prompt, a parser, a state
 * machine. Everything below it is one file that imports `@mlc-ai/web-llm`. The seam is
 * what lets every automated test here run with no model, no WebGPU, and no network -
 * which is not a convenience, it is the requirement: a test that downloaded a real model
 * would be a test that contacted a model host.
 *
 * The interface is deliberately small enough that a fake is a few lines. It takes a
 * prompt and returns the text the model produced, and it can be disposed. It does not
 * expose the engine, a chat history, a token stream, or the library's own types, so
 * nothing above here can reach around it to configure a model, choose a URL, or start a
 * second load.
 */

/** How far a load has got. Reported to the visitor as text and as a progress value. */
export interface LoadProgress {
  /**
   * Fraction complete in [0, 1], or null when the library reports none. The library's
   * own progress is not monotonic across its phases, so this is what it said rather
   * than something smoothed: a bar that only ever moved forward would be this page
   * inventing progress it was not told about.
   */
  readonly fraction: number | null
  /** The library's own one-line description of the phase. */
  readonly text: string
}

/** A loaded model, ready to answer. */
export interface SuggestEngine {
  /**
   * Runs one generation and returns the raw text.
   *
   * The text is unvalidated by definition: `parse.ts` is what decides whether any of it
   * reaches the page. An implementation must reject rather than resolve when the signal
   * aborts, so a cancelled generation is never mistaken for an empty answer.
   */
  readonly generate: (prompt: SuggestPrompt, signal: AbortSignal) => Promise<string>
  /**
   * Releases what the library permits. Called on cancellation, on opt-out, and when the
   * page goes away. It must be safe to call twice and must not reject.
   */
  readonly dispose: () => Promise<void>
}

/** Why a device cannot run the model, or that it can. */
export type SupportVerdict =
  | 'ok'
  /** No WebGPU at all: an older browser, or one with it turned off. */
  | 'no-webgpu'
  /** WebGPU is present but the adapter lacks the feature the pinned shaders need. */
  | 'no-feature'
  /** The probe itself failed. Reported as its own state rather than guessed at. */
  | 'probe-failed'

/*
 * A load failure is deliberately not classified here. `loadEngine` rejects with whatever
 * it was given, and `suggest/failure.ts` is the one place a cause becomes a kind and a
 * sentence. A second classification at this boundary would be a second answer to the same
 * question, and the two would drift.
 */

/** What the loader needs from its caller. Nothing here is a model setting. */
export interface LoadRequest {
  readonly onProgress: (progress: LoadProgress) => void
  /** Aborting must stop the load and release whatever was allocated. */
  readonly signal: AbortSignal
}

/**
 * Loads the pinned model. The only implementation is `webllm.ts`; the only other caller
 * is a test's fake.
 */
export type EngineLoader = (request: LoadRequest) => Promise<SuggestEngine>

/** What `load.ts` resolves to, and what a test replaces wholesale. */
export interface EngineModule {
  readonly probeSupport: () => Promise<SupportVerdict>
  readonly loadEngine: EngineLoader
  /** Whether the model's assets are already in the browser's cache, if it can be known. */
  readonly isCached: () => Promise<boolean>
}
