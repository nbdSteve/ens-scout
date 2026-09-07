import {
  CHECK_MAX_NAMES,
  CHECK_MAX_RESPONSE_BYTES,
  CHECK_PATH,
  isCheckCode,
  type CheckCode,
} from './contract'
import { assertCovers, parseCheckDocument, toVerification } from './parse'
import type { Verification } from './types'

/**
 * The fresh-check client.
 *
 * One request, one bounded answer, and nothing about the upstream in it. The
 * endpoint owns the Graph endpoint, the query, the retry policy, and the
 * authorization, and this client cannot influence any of them: the whole request
 * body is a list of names.
 *
 * Nothing from a response is ever carried into a message shown to a visitor. A
 * refusal reaches the page as a code from `CHECK_CODES` and a status, and
 * `failure.ts` writes the words. The endpoint composes its own bodies from fixed
 * literals for the same reason, and this is the second half of that guarantee: a
 * body that came from something other than the endpoint gets the same treatment.
 */

export class CheckError extends Error {
  override readonly name = 'CheckError'

  /** HTTP status, or null when the request never produced a response. */
  readonly status: number | null

  /** The endpoint's own code, when it answered with one this build knows. */
  readonly code: CheckCode | null

  constructor(message: string, status: number | null, code: CheckCode | null = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface CheckOptions {
  readonly baseUrl: string
  /** The fully-qualified names to verify. */
  readonly names: readonly string[]
  readonly signal?: AbortSignal
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Reads a body under the bound.
 *
 * The declared length is checked first so an oversized answer costs nothing to
 * refuse, and the body is checked again because the header is advisory. One UTF-16
 * unit is at least one byte, which makes the second check conservative.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number.parseInt(declared, 10)
    if (Number.isFinite(length) && length > CHECK_MAX_RESPONSE_BYTES) {
      throw new CheckError('the check answer is larger than this site will read', response.status)
    }
  }
  const text = await response.text()
  if (text.length > CHECK_MAX_RESPONSE_BYTES) {
    throw new CheckError('the check answer is larger than this site will read', response.status)
  }
  return text
}

/**
 * Reads the endpoint's own failure code out of a refusal, or null.
 *
 * Only a code this build already knows is accepted, and the accompanying `message`
 * is deliberately not read at all. A refusal is the one response most likely to
 * have come from something that is not the endpoint - a proxy, a portal, a WAF -
 * so it is the response whose text must not reach a screen.
 */
function readFailureCode(text: string): CheckCode | null {
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const error = (body as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return null
  }
  const code = (error as Record<string, unknown>)['code']
  return isCheckCode(code) ? code : null
}

/**
 * Verifies a bounded set of names against the ENS subgraph index, through the read
 * API's check endpoint.
 *
 * Throws `CheckError` for anything that is not one verified answer, `CheckFormatError`
 * for an answer this build refuses, and re-raises an `AbortError` unchanged so a
 * cancelled check can be dropped rather than reported.
 */
export async function requestCheck(options: CheckOptions): Promise<Verification> {
  if (options.names.length === 0) {
    throw new CheckError('a check needs at least one name', null)
  }
  // The page's own bound, charged before the request. A selection this large cannot
  // be assembled through the UI, so reaching here means something built a request the
  // page does not offer, and asking anyway would spend an allowance on a refusal.
  if (options.names.length > CHECK_MAX_NAMES) {
    throw new CheckError('a check covers too many names', null)
  }

  const url = `${options.baseUrl}${CHECK_PATH}`
  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: options.names }),
      // A fresh check is never served from a cache. Its whole value is the instant in
      // its body, and the endpoint answers `no-store` for the same reason.
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause
    }
    throw new CheckError('could not reach the check endpoint', null)
  }

  const text = await readBounded(response)
  if (!response.ok) {
    throw new CheckError(
      `the check endpoint returned HTTP ${String(response.status)}`,
      response.status,
      readFailureCode(text),
    )
  }

  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    throw new CheckError('the check answer was not JSON', response.status)
  }

  const document = parseCheckDocument(body)
  // Proved against what was asked for, not only against itself. An answer covering a
  // different set is not evidence about any name in it.
  assertCovers(document, options.names)
  return toVerification(document)
}
