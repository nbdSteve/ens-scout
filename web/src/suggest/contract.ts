/**
 * The bounds and the pinned model, for the local name recommender.
 *
 * This is a presentation feature and nothing else. It ranks names that are already in
 * the loaded snapshot while the page derives the explanations; it never invents a
 * candidate, never decides whether a name is registrable, and never reaches a network
 * service of any kind. The only thing that opens an outbound registration link is still
 * `verify/gate.ts`, which takes no parameter and cannot be told that a suggestion is
 * special.
 *
 * Every number here is a ceiling on work a device does or a wait a visitor sits
 * through. There is no retry loop behind any of them and no larger model to fall back
 * to: when a bound is reached, the deterministic recommender answers instead, and the
 * page says which of the two produced what is on screen.
 *
 * The model facts are separated from the model's asset URLs deliberately. This module
 * is imported by the panel, so it lands in the entry chunk; the URLs live in
 * `engine/webllm.ts`, which is only ever reached through a dynamic import. That split
 * is what keeps the core page's bundle naming no model host at all, and
 * `tests/browser/assets.spec.ts` asserts it.
 */

/**
 * The pinned model.
 *
 * `SmolLM2-360M-Instruct-q4f16_1-MLC` is the smallest download of every candidate in
 * `@mlc-ai/web-llm`'s own catalogue that is instruction-tuned at all - smaller than the
 * 135M model, which ships unquantized and is therefore a third larger on the wire - and
 * the task it is asked to do is bounded to choosing and ordering names from a supplied
 * list. `web/README.md` records the measurements and how to reproduce them.
 *
 * `contract.drift.test.ts` checks this against the library's own record, so a version
 * bump that renames the model, moves its weights, or changes its memory or feature
 * requirements fails a test rather than a visitor's device.
 */
export const MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC'

/**
 * What the first load transfers, in bytes: the seven weight shards, the tokenizer, the
 * compiled shader library, and the two manifests. Stated to a visitor before anything is
 * fetched, so the figure has to be the whole download rather than the weights alone, and
 * exact rather than rounded, because `web/README.md` records the measurement per file and
 * a rounded constant could not be checked against it.
 *
 * It is deliberately not the repository's total size. The library fetches `tokenizer.json`
 * and stops, so `vocab.json`, `merges.txt`, and `tokenizer_config.json` are published
 * beside the weights and never transferred; counting them would overstate the figure a
 * visitor is asked to agree to by about 1.2 MB.
 */
export const MODEL_DOWNLOAD_BYTES = 211_553_449

/**
 * Device memory the library declares this model needs, in MB. Checked against the
 * library's own record, and shown alongside the download size because the two failures
 * a visitor hits are different: one is a slow connection, the other is a device that
 * cannot hold the model at all.
 */
export const MODEL_VRAM_MB = 376.06

/** The WebGPU feature the pinned model's shaders require. */
export const MODEL_REQUIRED_FEATURE = 'shader-f16'

/**
 * Longest theme a visitor may type.
 *
 * Short on purpose. It is a hint, not a brief: the whole prompt has to stay inside a
 * context window a 360M model actually has, and a long free-text field is also the one
 * place on this page where a visitor could try to talk to the model instead of
 * describing what they want.
 */
export const THEME_MAX_CHARS = 60

/**
 * How many names the recommender may consider, and therefore how many the model is ever
 * shown. The shortlist is built by `shortlist.ts` from the loaded snapshot and the
 * filters already applied to the name field, so this bounds the prompt and nothing else.
 */
export const SHORTLIST_MAX = 24

/** How many names either recommender may return. */
export const SUGGESTIONS_MAX = 5

/**
 * Longest repository-owned explanation displayed for one name, in code points.
 *
 * The model supplies no prose. `shortlist.ts` derives each explanation from bounded
 * scoring evidence and refuses an internal template that would cross this ceiling.
 */
export const EXPLANATION_MAX_CHARS = 140

/** Hard ceiling on generated tokens, so one request cannot run long. */
export const GENERATION_MAX_TOKENS = 384

/**
 * How many times initialization is attempted per page load. One: a failed load is
 * reported and offered back to the visitor as a button, so retrying is a decision
 * somebody makes rather than a loop that spends a device's bandwidth unasked.
 */
export const INIT_MAX_ATTEMPTS = 1

/** Longest an initialization may run before it is abandoned and reported. */
export const INIT_TIMEOUT_MS = 10 * 60 * 1000

/** Longest one generation may run before it is abandoned and reported. */
export const GENERATE_TIMEOUT_MS = 60 * 1000

/**
 * How long a load may run before the page calls it slow.
 *
 * It is still loading, and saying so is the point: on a thin connection the honest
 * message is that this is taking a while and the deterministic recommender is already
 * available, not that something has failed.
 */
export const SLOW_AFTER_MS = 45 * 1000

/**
 * How long after the core page becomes interactive the load waits before it starts.
 *
 * Not a performance tweak. The download is large enough that a visitor has to be able
 * to stop it before it begins, so this is the window in which the size notice is on
 * screen and the pause and disable controls are reachable with nothing yet in flight.
 */
export const START_GRACE_MS = 6 * 1000

/**
 * Where the opt-out is kept.
 *
 * Versioned like the snapshot cache key, for the same reason: if what this holds ever
 * changes shape, the previous key is read by nothing and replaced by nothing rather
 * than being reinterpreted. `optOut.ts` sweeps the ones it no longer uses.
 */
export const OPT_OUT_KEY_PREFIX = 'ens-scout.suggest-opt-out.v'
export const OPT_OUT_VERSION = 1
export const OPT_OUT_KEY = `${OPT_OUT_KEY_PREFIX}${String(OPT_OUT_VERSION)}`
