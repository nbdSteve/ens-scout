import { CheckError } from './check'
import type { CheckCode } from './contract'
import { CheckFormatError, CheckVersionError } from './parse'

/**
 * What the page says when a fresh check does not produce an answer.
 *
 * Every sentence here is a fixed literal. Nothing from a response - not the
 * endpoint's own `message`, not a body from whatever answered instead of it - reaches
 * a screen, because the endpoint carries its Graph API key in its upstream request
 * path and any quoted text is a way for that to travel. The endpoint composes its own
 * failure bodies from literals for exactly this reason; this is the other half.
 *
 * That key's environment variable is deliberately not named here. Vite ships a source
 * map, so every comment in this directory is a file `dist/` serves, and `assets.spec.ts`
 * scans the built output for that name as a literal. The name belongs to the Go side,
 * which is the only place it means anything.
 *
 * The kinds are separate because the honest sentences are different. One sentence for
 * all of them was the shape to avoid: a spent allowance, an index that did not
 * answer, a deployment with no verifier at all, and an answer this build refused are
 * four different things, and three of them would have been misdescribed.
 *
 * There is deliberately no countdown. The endpoint sends `Retry-After` on the
 * failures it declares retryable, and a rendered "try again in 43 seconds" would be
 * wrong the moment the visitor looked away. `retryable` carries the same information
 * as a decision the page can act on - whether to offer the button again - without
 * putting a number on screen that keeps aging.
 */
export type CheckFailureKind =
  /** This visitor's own allowance is spent. */
  | 'throttled'
  /** The site's shared allowance or its concurrency limit is spent. */
  | 'busy'
  /** No answer arrived in the time available. */
  | 'timeout'
  /** The ENS index did not answer. */
  | 'upstream'
  /** More names than the endpoint accepts in one check. */
  | 'selection'
  /** The endpoint refused the request itself, which means this page built a bad one. */
  | 'refused'
  /** This deployment serves no check endpoint. */
  | 'unsupported'
  /** An answer arrived and this build refused it. */
  | 'malformed'
  /** An answer arrived in a format newer than this build. */
  | 'version'
  /** Anything else, including no response at all. */
  | 'unavailable'

export interface CheckFailure {
  readonly kind: CheckFailureKind
  /** The whole sentence shown to a visitor. Always a fixed literal. */
  readonly message: string
  /** Whether asking again, unchanged, could succeed. */
  readonly retryable: boolean
}

/*
 * Every code the endpoint answers with, mapped to a kind. It is a total map over
 * `CheckCode` rather than a switch with a default, so a code added to
 * `CHECK_CODES` - which `contract.drift.test.ts` requires whenever Go adds one - is a
 * type error here instead of a refusal that quietly falls through to 'unavailable'.
 */
const KIND_BY_CODE: Readonly<Record<CheckCode, CheckFailureKind>> = {
  unsupported_media_type: 'refused',
  request_too_large: 'refused',
  malformed_request: 'refused',
  no_names_requested: 'refused',
  too_many_names: 'selection',
  invalid_name: 'refused',
  /*
   * The endpoint could not identify the caller, so it cannot apply a per-client
   * allowance and refuses rather than serving unmetered. It is the site's own
   * configuration, not this visitor's doing, and no retry clears it.
   */
  client_unidentified: 'unavailable',
  client_throttled: 'throttled',
  /*
   * The endpoint could not reach the shared store that holds the allowances, so it
   * refused rather than serving a request nothing could charge. It is 'unavailable'
   * rather than 'busy' because nothing about this visitor or about how busy the site
   * is caused it, and asking again can clear it: the usual cause is a throttled
   * table.
   */
  check_store_unavailable: 'unavailable',
  upstream_busy: 'busy',
  upstream_budget_exhausted: 'busy',
  check_timed_out: 'timeout',
  upstream_unavailable: 'upstream',
  /*
   * Sent when the request went away. A visitor who navigated away sees nothing, so
   * this reaches a screen only when something in between dropped the connection,
   * which is an outage from here and not a cancellation.
   */
  check_cancelled: 'unavailable',
  method_not_allowed: 'unsupported',
  not_found: 'unsupported',
}

const MESSAGE_BY_KIND: Readonly<Record<CheckFailureKind, string>> = {
  throttled: 'You have checked several names in quick succession. Wait a moment and check again.',
  busy: 'This site is checking as many names as it can right now. Wait a moment and check again.',
  timeout: 'The check did not finish in time. No name was verified.',
  upstream: 'The ENS index did not answer. No name was verified.',
  selection: 'That is more names than one check covers. Select fewer names and check again.',
  refused: 'This site could not put the check together. No name was verified.',
  unsupported: 'This deployment does not offer fresh checks.',
  malformed: 'The answer did not match what this site accepts, so it was not used.',
  version: 'The answer is in a newer format than this page reads. Reload to pick up the new page.',
  unavailable: 'The check could not be made. No name was verified.',
}

/*
 * Whether asking again, with the same selection and the same page, could succeed.
 *
 * 'selection' is retryable in the sense that a smaller selection works, but not with
 * this request, and the button it governs offers this request - so it is false and the
 * sentence says what to change instead.
 */
const RETRYABLE_BY_KIND: Readonly<Record<CheckFailureKind, boolean>> = {
  throttled: true,
  busy: true,
  timeout: true,
  upstream: true,
  selection: false,
  refused: false,
  unsupported: false,
  malformed: true,
  version: false,
  unavailable: true,
}

/**
 * Classifies a thrown value into one kind.
 *
 * A code the endpoint sent is trusted over the status, because the two disagree on
 * purpose: several distinct refusals share a 503, and the code is what tells them
 * apart. The status is the fallback for a response that carried no code this build
 * knows, which is what an intermediary answering instead of the endpoint looks like.
 */
export function describeCheckFailure(cause: unknown): CheckFailure {
  const kind = kindOf(cause)
  return { kind, message: MESSAGE_BY_KIND[kind], retryable: RETRYABLE_BY_KIND[kind] }
}

function kindOf(cause: unknown): CheckFailureKind {
  // Checked before CheckFormatError, which it extends.
  if (cause instanceof CheckVersionError) {
    return 'version'
  }
  if (cause instanceof CheckFormatError) {
    return 'malformed'
  }
  if (!(cause instanceof CheckError)) {
    return 'unavailable'
  }
  if (cause.code !== null) {
    return KIND_BY_CODE[cause.code]
  }
  return kindOfStatus(cause.status)
}

function kindOfStatus(status: number | null): CheckFailureKind {
  if (status === null) {
    return 'unavailable'
  }
  switch (status) {
    case 404:
    case 405:
      return 'unsupported'
    case 413:
      return 'selection'
    case 429:
      return 'throttled'
    case 504:
      return 'timeout'
    default:
      return 'unavailable'
  }
}

/**
 * Whether only a document load can clear this failure.
 *
 * The same rule `components/recovery.ts` states for a snapshot load, and stated here
 * rather than shared with it because the two read different kinds. A version mismatch
 * is the one thing another request cannot fix: the answer is newer than this bundle,
 * so asking again from this bundle lands on the same refusal.
 */
export function checkNeedsNewBundle(kind: CheckFailureKind): boolean {
  return kind === 'version'
}
