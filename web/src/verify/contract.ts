/**
 * The check wire contract, restated for the browser.
 *
 * `internal/api` owns every value in the first group, and none of them can be
 * derived from a response: a client has to know which format version it accepts
 * before it reads one, and it has to know which source and which authority a
 * genuine answer declares before it can refuse an answer that declares something
 * else. `contract.drift.test.ts` parses the Go sources and fails when any of them
 * moves.
 *
 * The second group is the browser's own. A bound the page applies to itself is not
 * a mirror of a server bound and must not be written as one: the server's limits
 * are per deployment and configurable, so this page keeps its own smaller ones and
 * still handles the server's refusal when a deployment has set one lower.
 *
 * The advisory wording is deliberately absent. Every sentence this page shows about
 * a check is written here, never taken from `advisory` or from an error `message`,
 * because text from a response is text an unexpected or hostile answer could put on
 * screen.
 */

/** The endpoint one fresh check is asked for at. */
export const CHECK_PATH = '/api/check'

/**
 * The only check format version this build reads. A response declaring another
 * one is refused whole rather than read for the fields that look familiar.
 */
export const CHECK_FORMAT_VERSION = 1

/**
 * What a fresh answer says produced it: one live read of the ENS subgraph index.
 * It is not the registry, and the page says so wherever it shows a checked name.
 */
export const CHECK_SOURCE = 'ens-subgraph-index'

/** What actually decides whether a name can be registered. */
export const CHECK_AUTHORITY = 'ens-registry'

/**
 * Every failure code the check endpoint answers with, plus the two an ordinary
 * request error carries. `failure.ts` maps each one to what the page says; naming
 * them exhaustively is what makes a new code in Go a failing test here rather than
 * a response that quietly falls through to the vaguest available wording.
 */
export const CHECK_CODES = [
  'unsupported_media_type',
  'request_too_large',
  'malformed_request',
  'no_names_requested',
  'too_many_names',
  'invalid_name',
  'client_unidentified',
  'client_throttled',
  'check_store_unavailable',
  'upstream_busy',
  'upstream_budget_exhausted',
  'check_timed_out',
  'upstream_unavailable',
  'check_cancelled',
  'method_not_allowed',
  'not_found',
] as const

export type CheckCode = (typeof CHECK_CODES)[number]

export function isCheckCode(value: unknown): value is CheckCode {
  return typeof value === 'string' && (CHECK_CODES as readonly string[]).includes(value)
}

/**
 * How many names one check covers, chosen here rather than read from the server.
 *
 * It is a selection a visitor can hold in their head and act on, and it is well
 * under `DefaultCheckMaxNames` so an ordinary deployment never refuses a selection
 * this page permitted. The drift test asserts it stays under that default rather
 * than equal to it: the server bound is configurable per deployment, and a
 * deployment that lowers it below this must surface through the endpoint's own
 * `too_many_names` refusal, which `failure.ts` words for exactly that case.
 */
export const CHECK_MAX_NAMES = 10

/**
 * The largest check response this build reads. A response covering
 * `CHECK_MAX_NAMES` names is a few kilobytes, so this is generous by a wide margin
 * and exists only so a body has a bound at all.
 *
 * There is deliberately no label-length bound here. Every name this page can offer
 * for a check came out of a published snapshot, so it already passed
 * `names.Normalize`; a label long enough for the endpoint to refuse is reported
 * through its own refusal rather than pre-judged by a second rule that would then
 * have to be kept in step with the server's.
 */
export const CHECK_MAX_RESPONSE_BYTES = 64 * 1024
