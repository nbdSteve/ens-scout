import type { SupportVerdict } from './engine/types'
import { SuggestFormatError } from './parse'

/**
 * What the panel says when the model does not produce an answer.
 *
 * Every sentence is a fixed literal, chosen by kind. Nothing from a thrown error reaches
 * a screen: the library's messages quote asset URLs, adapter strings, and buffer sizes,
 * none of which mean anything to a visitor and one of which is a hostname this page
 * otherwise never shows. It is the same rule `verify/failure.ts` follows for the check
 * endpoint, for a different reason - there the text could carry a credential, here it
 * carries a model host - and the same discipline either way.
 *
 * The kinds are separate because the honest sentences differ and because the actions do.
 * A device with no WebGPU is not going to acquire it, so it is told once and offered
 * nothing; a device that ran out of memory can be given room; a refused answer means the
 * model ran perfectly well and said something this build would not use, which is not a
 * failure the visitor can do anything about and not one worth alarming them over.
 *
 * Every one of these ends the same way in practice: the deterministic recommender has
 * already answered, and the panel says which of the two produced what is on screen. That
 * is why none of these sentences apologises for having no names - there are names.
 */

export type SuggestFailureKind =
  /** This browser has no WebGPU. */
  | 'unsupported'
  /** WebGPU is present and the adapter cannot run the pinned model's shaders. */
  | 'unsupported-feature'
  /** Asking the adapter failed. Reported rather than guessed either way. */
  | 'probe-failed'
  /** The device is offline, so the assets cannot be fetched. */
  | 'offline'
  /** The assets or the library chunk could not be fetched, and the device is online. */
  | 'blocked'
  /** The device could not hold the model. */
  | 'memory'
  /** The load ran past its bound. */
  | 'load-timeout'
  /** Anything else during loading. */
  | 'load-failed'
  /** One generation ran past its bound. */
  | 'generate-timeout'
  /** An answer arrived and this build refused it. */
  | 'generate-refused'
  /** Anything else during generation. */
  | 'generate-failed'

export type SuggestFailureStage = 'support' | 'loading' | 'generation'

export interface SuggestFailure {
  readonly stage: SuggestFailureStage
  readonly kind: SuggestFailureKind
  /** The whole sentence shown to a visitor. Always a fixed literal. */
  readonly message: string
  /** Whether trying the same thing again could succeed. */
  readonly retryable: boolean
}

const MESSAGE_BY_KIND: Readonly<Record<SuggestFailureKind, string>> = {
  unsupported:
    'This browser cannot run the on-device model, so the names below are ranked without it.',
  'unsupported-feature':
    'This device’s graphics hardware cannot run the on-device model, so the names below are ranked without it.',
  'probe-failed':
    'This page could not tell whether the on-device model would run here, so the names below are ranked without it.',
  offline:
    'The model cannot be downloaded while this device is offline. The names below are ranked without it.',
  blocked: 'The model files could not be downloaded. The names below are ranked without it.',
  memory:
    'This device did not have enough memory for the model. Closing other tabs and trying again may help.',
  'load-timeout':
    'The model did not finish loading in the time allowed. The names below are ranked without it.',
  'load-failed': 'The model could not be loaded. The names below are ranked without it.',
  'generate-timeout':
    'The model did not answer in the time allowed, so the names below are ranked without it.',
  'generate-refused':
    'The model’s answer did not match what this page accepts, so it was not used. The names below are ranked without it.',
  'generate-failed': 'The model did not answer, so the names below are ranked without it.',
}

/*
 * Whether asking again, unchanged, could succeed.
 *
 * The three device verdicts are false because nothing about this page or this moment
 * caused them. 'generate-refused' is true because a small model asked the same question
 * twice does not always answer the same way, and the cost of asking again is one bounded
 * generation against a model that is already loaded.
 */
const RETRYABLE_BY_KIND: Readonly<Record<SuggestFailureKind, boolean>> = {
  unsupported: false,
  'unsupported-feature': false,
  'probe-failed': false,
  offline: true,
  blocked: true,
  memory: true,
  'load-timeout': true,
  'load-failed': true,
  'generate-timeout': true,
  'generate-refused': true,
  'generate-failed': true,
}

function describe(kind: SuggestFailureKind, stage: SuggestFailureStage): SuggestFailure {
  return { stage, kind, message: MESSAGE_BY_KIND[kind], retryable: RETRYABLE_BY_KIND[kind] }
}

/**
 * A device verdict as a failure, or null when the device can run the model.
 *
 * A total map rather than a switch with a default, so a verdict added to `SupportVerdict`
 * is a type error here instead of quietly becoming the vaguest sentence.
 */
const KIND_BY_VERDICT: Readonly<Record<SupportVerdict, SuggestFailureKind | null>> = {
  ok: null,
  'no-webgpu': 'unsupported',
  'no-feature': 'unsupported-feature',
  'probe-failed': 'probe-failed',
}

export function describeSupport(verdict: SupportVerdict): SuggestFailure | null {
  const kind = KIND_BY_VERDICT[verdict]
  return kind === null ? null : describe(kind, 'support')
}

/** Raised by the state machine when its own bound is reached. */
export class SuggestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestTimeoutError'
  }
}

/**
 * Words the library and the platform use when a device cannot hold the model.
 *
 * Matching text is a best-effort classification and it is the only one available: the
 * library reports this as a message rather than as a type, and the underlying failure
 * arrives from WebGPU as a device-lost reason or from the allocator as a `RangeError`.
 * Anything unrecognised stays 'load-failed', which is the honest default - a wrong guess
 * here would tell a visitor to close tabs about a failure that had nothing to do with
 * memory.
 */
const MEMORY_PATTERNS = [
  'out of memory',
  'outofmemory',
  'oom',
  'not enough memory',
  'insufficient memory',
  'device lost',
  'device was lost',
  'exceeds the limit',
  'maxbuffersize',
  'maxstoragebufferbindingsize',
  'allocation failed',
  'array buffer allocation failed',
]

/** Words that mean a fetch did not happen, as distinct from one that answered badly. */
const NETWORK_PATTERNS = [
  'failed to fetch',
  'networkerror',
  'network error',
  'load failed',
  'err_internet_disconnected',
  'dynamically imported module',
  'importing a module script failed',
  'error loading',
]

function textOf(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name} ${cause.message}`.toLowerCase()
  }
  return typeof cause === 'string' ? cause.toLowerCase() : ''
}

function matches(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

/**
 * Whether the device says it is offline.
 *
 * `navigator.onLine` is only trustworthy in one direction - false means no connection,
 * true means very little - so it is used only to choose between two sentences about a
 * fetch that already failed, never to decide whether to try.
 */
function offline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine
}

/** Classifies a failure raised while loading the model. */
export function describeLoadFailure(cause: unknown): SuggestFailure {
  if (cause instanceof SuggestTimeoutError) {
    return describe('load-timeout', 'loading')
  }
  const text = textOf(cause)
  if (matches(text, MEMORY_PATTERNS)) {
    return describe('memory', 'loading')
  }
  if (offline()) {
    return describe('offline', 'loading')
  }
  if (matches(text, NETWORK_PATTERNS)) {
    return describe('blocked', 'loading')
  }
  return describe('load-failed', 'loading')
}

/**
 * Classifies a failure raised while generating.
 *
 * A refused answer is checked first and is not a network or memory condition: the model
 * ran, produced text, and `parse.ts` would not use it.
 */
export function describeGenerateFailure(cause: unknown): SuggestFailure {
  if (cause instanceof SuggestFormatError) {
    return describe('generate-refused', 'generation')
  }
  if (cause instanceof SuggestTimeoutError) {
    return describe('generate-timeout', 'generation')
  }
  if (matches(textOf(cause), MEMORY_PATTERNS)) {
    return describe('memory', 'generation')
  }
  return describe('generate-failed', 'generation')
}
