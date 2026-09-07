import { describe, expect, it, vi } from 'vitest'
import { CheckError, requestCheck } from './check'
import {
  CHECK_AUTHORITY,
  CHECK_FORMAT_VERSION,
  CHECK_MAX_NAMES,
  CHECK_MAX_RESPONSE_BYTES,
  CHECK_PATH,
  CHECK_SOURCE,
} from './contract'
import { CheckFormatError } from './parse'

/**
 * The client, exercised entirely against injected fetches. Nothing here reaches a
 * network: the endpoint's own behaviour is proved in `internal/api`, and what is
 * proved here is what this page does with each answer.
 */

const BASE_URL = 'https://api.example.test'

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: CHECK_FORMAT_VERSION,
    source: CHECK_SOURCE,
    authority: CHECK_AUTHORITY,
    checked_at: '2026-03-01T12:00:00Z',
    expires_at: '2026-03-01T12:01:00Z',
    names: ['aaa.eth'],
    results: [{ name: 'aaa.eth', status: 'available' }],
    advisory: 'Confirm availability and price with ENS before registering.',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** One recorded request: the URL asked for and the init it was asked with. */
type FetchCall = readonly [string, RequestInit]

interface RecordedFetch {
  readonly impl: typeof fetch
  readonly calls: readonly FetchCall[]
}

/**
 * A `fetch` that records what it was asked and answers with a fixed response. Typed
 * as `typeof fetch` rather than cast into it, so a change to the call the client makes
 * is a type error here.
 */
function recordingFetch(respond: () => Response): RecordedFetch {
  const calls: FetchCall[] = []
  const impl: typeof fetch = (input, init) => {
    calls.push([input as string, init ?? {}])
    return Promise.resolve(respond())
  }
  return { impl, calls }
}

function fetchReturning(response: Response): typeof fetch {
  return recordingFetch(() => response).impl
}

describe('requestCheck', () => {
  it('posts the names as JSON and returns the verification', async () => {
    const recorded = recordingFetch(() => jsonResponse(answer()))
    const view = await requestCheck({
      baseUrl: BASE_URL,
      names: ['aaa.eth'],
      fetchImpl: recorded.impl,
    })

    expect(view.names).toEqual(['aaa.eth'])
    expect(view.checkedAt.toISOString()).toBe('2026-03-01T12:00:00.000Z')
    expect(view.results[0]?.status).toBe('available')

    const [url, init] = recorded.calls[0]!
    expect(url).toBe(`${BASE_URL}${CHECK_PATH}`)
    expect(init.method).toBe('POST')
    // The whole request, byte for byte. Nothing in it can select an endpoint, a query, a
    // retry policy, or an authorization, and asserting the exact body is what keeps a
    // future field from being added without a decision.
    expect(init.body).toBe('{"names":["aaa.eth"]}')
    expect(init.credentials).toBe('omit')
    // A fresh check must never be served from a cache: its value is the instant in it.
    expect(init.cache).toBe('no-store')
  })

  it('sends no credentials and no header beyond the two it needs', async () => {
    const recorded = recordingFetch(() => jsonResponse(answer()))
    await requestCheck({ baseUrl: BASE_URL, names: ['aaa.eth'], fetchImpl: recorded.impl })
    const headers = recorded.calls[0]![1].headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'Content-Type'])
  })

  it('refuses to ask about no names', async () => {
    await expect(
      requestCheck({ baseUrl: BASE_URL, names: [], fetchImpl: fetchReturning(jsonResponse({})) }),
    ).rejects.toThrow(CheckError)
  })

  /*
   * Charged here rather than left to the endpoint. A selection this size cannot be
   * built through the UI, so reaching this line means something assembled a request the
   * page does not offer, and asking anyway would spend an allowance on a refusal.
   */
  it('refuses more names than one check covers, without asking', async () => {
    const recorded = recordingFetch(() => jsonResponse(answer()))
    const names = Array.from({ length: CHECK_MAX_NAMES + 1 }, (_, index) => `n${String(index)}.eth`)
    await expect(
      requestCheck({ baseUrl: BASE_URL, names, fetchImpl: recorded.impl }),
    ).rejects.toThrow(CheckError)
    expect(recorded.calls).toHaveLength(0)
  })

  it('reports the endpoint failure code from a refusal', async () => {
    const body = { error: { code: 'client_throttled', message: 'slow down' }, advisory: '...' }
    let raised: unknown
    try {
      await requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(jsonResponse(body, 429, { 'Retry-After': '60' })),
      })
    } catch (cause) {
      raised = cause
    }
    expect(raised).toBeInstanceOf(CheckError)
    expect((raised as CheckError).code).toBe('client_throttled')
    expect((raised as CheckError).status).toBe(429)
  })

  /*
   * A refusal is the response most likely not to have come from the endpoint at all -
   * a proxy, a portal, a WAF - so its text must not reach a screen. The client keeps
   * the code and drops the message.
   */
  it('never carries a refusal message into the error it raises', async () => {
    const leak = 'https://gateway.example/api/deadbeefsecretkey/subgraphs/id/x'
    const body = { error: { code: 'upstream_unavailable', message: leak } }
    let raised: unknown
    try {
      await requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(jsonResponse(body, 502)),
      })
    } catch (cause) {
      raised = cause
    }
    expect((raised as CheckError).message).not.toContain(leak)
    expect((raised as CheckError).message).not.toContain('deadbeefsecretkey')
  })

  it('reports no code when a refusal carries one this build does not know', async () => {
    const body = { error: { code: 'invented_by_a_proxy', message: 'nope' } }
    let raised: unknown
    try {
      await requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(jsonResponse(body, 503)),
      })
    } catch (cause) {
      raised = cause
    }
    expect((raised as CheckError).code).toBeNull()
    expect((raised as CheckError).status).toBe(503)
  })

  it('reports no code when a refusal is not JSON at all', async () => {
    const response = new Response('<html>blocked by your network</html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    })
    let raised: unknown
    try {
      await requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(response),
      })
    } catch (cause) {
      raised = cause
    }
    expect((raised as CheckError).code).toBeNull()
    expect((raised as CheckError).message).not.toContain('blocked by your network')
  })

  it('refuses an answer that is not JSON', async () => {
    const response = new Response('not json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    await expect(
      requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(response),
      }),
    ).rejects.toThrow(CheckError)
  })

  it('refuses an answer whose declared length is over the bound, before reading it', async () => {
    const text = vi.fn(() => Promise.resolve(''))
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(CHECK_MAX_RESPONSE_BYTES + 1) }),
      text,
    } as unknown as Response
    await expect(
      requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(response),
      }),
    ).rejects.toThrow(/larger than this site will read/)
    expect(text).not.toHaveBeenCalled()
  })

  it('refuses an oversized answer whose header understated it', async () => {
    // The header is advisory, which is why the body is bounded again.
    const response = new Response('x'.repeat(CHECK_MAX_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    await expect(
      requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth'],
        fetchImpl: fetchReturning(response),
      }),
    ).rejects.toThrow(/larger than this site will read/)
  })

  it('refuses an answer covering a name that was not asked about', async () => {
    await expect(
      requestCheck({
        baseUrl: BASE_URL,
        names: ['zzz.eth'],
        fetchImpl: fetchReturning(jsonResponse(answer())),
      }),
    ).rejects.toThrow(CheckFormatError)
  })

  /*
   * A truncated answer. The endpoint proves the same property against its upstream,
   * and it is proved again here because the endpoint is not the only thing in between.
   */
  it('refuses an answer that covers only some of the names', async () => {
    await expect(
      requestCheck({
        baseUrl: BASE_URL,
        names: ['aaa.eth', 'bbb.eth'],
        fetchImpl: fetchReturning(jsonResponse(answer())),
      }),
    ).rejects.toThrow(CheckFormatError)
  })

  it('reports an unreachable endpoint without a status', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    let raised: unknown
    try {
      await requestCheck({ baseUrl: BASE_URL, names: ['aaa.eth'], fetchImpl })
    } catch (cause) {
      raised = cause
    }
    expect(raised).toBeInstanceOf(CheckError)
    expect((raised as CheckError).status).toBeNull()
    expect((raised as CheckError).code).toBeNull()
  })

  /*
   * An abort is re-raised unchanged so a caller can drop it. A cancelled check is not a
   * failed one, and reporting it would put an error on screen for a visitor who simply
   * changed their selection.
   */
  it('re-raises an abort unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const fetchImpl: typeof fetch = () => Promise.reject(abort)
    let raised: unknown
    try {
      await requestCheck({ baseUrl: BASE_URL, names: ['aaa.eth'], fetchImpl })
    } catch (cause) {
      raised = cause
    }
    expect(raised).toBe(abort)
  })

  it('passes the signal through so a check can be cancelled', async () => {
    const controller = new AbortController()
    const recorded = recordingFetch(() => jsonResponse(answer()))
    await requestCheck({
      baseUrl: BASE_URL,
      names: ['aaa.eth'],
      signal: controller.signal,
      fetchImpl: recorded.impl,
    })
    expect(recorded.calls[0]![1].signal).toBe(controller.signal)
  })
})
