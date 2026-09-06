import { assertPointerMatches, parseLatestDocument, parseSnapshotDocument } from '../snapshot/parse'
import type { LatestDocument, SnapshotDocument } from '../snapshot/types'

/**
 * The read API client.
 *
 * The browser reads one published snapshot from one origin. It never queries The
 * Graph, never reads DynamoDB, and never asks for a fresh check of a single name:
 * everything on screen came from the scan the snapshot records, which is the only
 * way the page can honestly say when its data is from.
 */

/** The snapshot resource. `ETag` carries the snapshot id and `If-None-Match` revalidates it. */
export const SNAPSHOT_PATH = '/api/snapshot'

/** The latest pointer, which adds the publication time and the integrity summary. */
export const LATEST_PATH = '/api/latest'

/**
 * A published snapshot is a few hundred kilobytes. A response far larger than
 * the largest plausible scan is a wrong endpoint or a hostile one, and reading it
 * to completion to find that out would be the damage.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export class ApiError extends Error {
  override readonly name = 'ApiError'

  /** HTTP status, or null when the request never produced a response. */
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
  }
}

export type FetchOutcome =
  | {
      readonly kind: 'fresh'
      readonly snapshot: SnapshotDocument
      readonly latest: LatestDocument | null
      readonly etag: string | null
    }
  /** The server confirmed the cached snapshot is still current. */
  | { readonly kind: 'not-modified' }

export interface FetchOptions {
  readonly baseUrl: string
  /** ETag of the cached snapshot, sent as `If-None-Match`. */
  readonly etag?: string | null
  readonly signal?: AbortSignal
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
}

async function readBoundedText(response: Response, what: string): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number.parseInt(declared, 10)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new ApiError(`${what} is larger than this site will read`, response.status)
    }
  }
  const text = await response.text()
  // The header is advisory, so the body is checked too. One UTF-16 unit is at
  // least one byte, which makes this a conservative bound.
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ApiError(`${what} is larger than this site will read`, response.status)
  }
  return text
}

async function request(
  url: string,
  options: FetchOptions,
  headers: Record<string, string>,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  try {
    return await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      // The site does its own conditional revalidation, so the HTTP cache must
      // not answer from its own copy - but it may still serve a 304.
      cache: 'no-cache',
      credentials: 'omit',
      redirect: 'follow',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause
    }
    throw new ApiError(`could not reach ${url}`, null)
  }
}

async function readJson(response: Response, what: string): Promise<unknown> {
  const text = await readBoundedText(response, what)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError(`${what} was not JSON`, response.status)
  }
}

/**
 * Fetches the pointer. A 404 is accepted, because the pointer is extra detail and
 * a deployment may not expose it. Everything else - a network failure, a 500, a
 * body that does not parse - is an error, because a route that answers badly is
 * not the same as a route that is not there.
 */
async function fetchLatest(options: FetchOptions): Promise<LatestDocument | null> {
  const url = `${options.baseUrl}${LATEST_PATH}`
  const response = await request(url, options, {})
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new ApiError(`${url} returned HTTP ${String(response.status)}`, response.status)
  }
  return parseLatestDocument(await readJson(response, 'the latest pointer'))
}

/**
 * Fetches the current snapshot, revalidating a cached copy when an ETag is given.
 *
 * Returns `not-modified` on HTTP 304, which is the whole point of holding the
 * ETag: a visitor who reloads a page whose snapshot has not changed transfers
 * headers instead of the entire scan.
 */
export async function fetchSnapshot(options: FetchOptions): Promise<FetchOutcome> {
  const url = `${options.baseUrl}${SNAPSHOT_PATH}`
  const etag = options.etag ?? null
  const response = await request(url, options, etag === null ? {} : { 'If-None-Match': etag })

  if (response.status === 304) {
    return { kind: 'not-modified' }
  }
  if (!response.ok) {
    throw new ApiError(`${url} returned HTTP ${String(response.status)}`, response.status)
  }

  const snapshot = parseSnapshotDocument(await readJson(response, 'the snapshot'))
  const latest = await fetchLatest(options)
  if (latest !== null) {
    assertPointerMatches(snapshot, latest)
  }
  return { kind: 'fresh', snapshot, latest, etag: response.headers.get('etag') }
}
