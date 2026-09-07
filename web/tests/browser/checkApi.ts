import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator, Page, Route } from '@playwright/test'
import type { Status } from '../../src/snapshot/contract'
import {
  CHECK_AUTHORITY,
  CHECK_FORMAT_VERSION,
  CHECK_SOURCE,
  type CheckCode,
} from '../../src/verify/contract'
import { visit } from './support'

/**
 * The read API, as the `verify` project's bundle sees it.
 *
 * That bundle is built with `VITE_API_BASE_URL` set, which is what turns the tick
 * boxes and the outbound links on, and it therefore loads its snapshot over the
 * network rather than from a fixture compiled into it. Both the snapshot and the
 * pointer are served here out of the committed `preview` fixture, so the rows, the
 * counts, and the statuses are exactly the ones the other four projects assert
 * against - the only difference between the two bundles is whether a check can be
 * made at all.
 *
 * Nothing here reaches a real service. Every request the page makes is intercepted,
 * and `vite preview` serves nothing under `/api`, so a path this file does not route
 * gets a 404 instead of travelling anywhere.
 *
 * The check responses are built by hand rather than by importing a builder from
 * `src/`. A stub the production parser helped construct would agree with it by
 * construction, and what these tests are for is the parser refusing an answer: a
 * different covered set, a newer format version, a refusal body carrying text.
 */

const FIXTURES = new URL('../../../data/fixtures/preview/', import.meta.url)

/** What `internal/api` sends, so a response the page reads looks like the real one. */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * The advisory a real answer carries, from `internal/api/checkconfig.go`.
 *
 * It is required and non-empty, and it is deliberately never rendered: every
 * sentence the page shows about a check is written in `src/verify/`. It is here so
 * the stub is a document the endpoint could really have sent.
 */
const ADVISORY =
  'This is one live read of the ENS subgraph index at the stated instant, not a reservation and not a quote. A name the index does not hold may still fail to register. Confirm availability and price with ENS before registering.'

function committed(file: string): Promise<string> {
  // `fileURLToPath`, not `URL.pathname`: the latter keeps the leading slash, which on
  // Windows yields `/C:/...` and opens nothing. `assets.spec.ts` says the same.
  return readFile(fileURLToPath(new URL(file, FIXTURES)), 'utf8')
}

/**
 * Serves the committed `preview` snapshot and its pointer.
 *
 * Both are routed, rather than letting the pointer 404 into the client's accepted
 * "this deployment does not expose it" path: `assertPointerMatches` running against
 * a real pointer is part of what the page does on every load, and a test that
 * skipped it would exercise a shape no deployment serves.
 */
export async function stubSnapshot(page: Page): Promise<void> {
  await page.route('**/api/snapshot', async (route) => {
    await route.fulfill({
      body: await committed('snapshot.json'),
      headers: { 'content-type': JSON_TYPE },
    })
  })
  await page.route('**/api/latest', async (route) => {
    await route.fulfill({
      body: await committed('latest.json'),
      headers: { 'content-type': JSON_TYPE },
    })
  })
}

/**
 * Opens the verifier build at a simulated instant, with the snapshot routed.
 *
 * One call, because the routes have to be in place before the document loads and a
 * test that navigated first would race its own snapshot request.
 */
export async function openVerified(page: Page, params: Record<string, string> = {}): Promise<void> {
  await stubSnapshot(page)
  await visit(page, params)
}

/** One name in a stubbed answer. The wire spelling, so the stub is the wire shape. */
export interface CheckedName {
  readonly name: string
  readonly status: Status
  readonly expiry?: string
}

/** One whole stubbed answer, with the two fields a test overrides to make a bad one. */
export interface CheckAnswer {
  readonly checkedAt: string
  readonly expiresAt: string
  /** In canonical order: byte-wise ascending, no duplicates. The parser checks. */
  readonly results: readonly CheckedName[]
  /** Overrides the covered set, for an answer that covers something else. */
  readonly names?: readonly string[]
  /** Overrides the declared version, for an answer from a newer format. */
  readonly formatVersion?: number
}

/** The success document, exactly as `internal/api` serializes one. */
export function checkDocument(answer: CheckAnswer): unknown {
  return {
    format_version: answer.formatVersion ?? CHECK_FORMAT_VERSION,
    source: CHECK_SOURCE,
    authority: CHECK_AUTHORITY,
    checked_at: answer.checkedAt,
    expires_at: answer.expiresAt,
    names: answer.names ?? answer.results.map((result) => result.name),
    results: answer.results.map((result) => ({
      name: result.name,
      status: result.status,
      ...(result.expiry === undefined ? {} : { expiry: result.expiry }),
    })),
    advisory: ADVISORY,
  }
}

/**
 * Text that must never reach a screen, shaped like the thing that makes the rule
 * matter: the check endpoint's upstream is the Graph gateway, which carries
 * `THEGRAPH_API_KEY` in its request path, so any response text the page quoted
 * would be a way for a credential to travel. The key here is invented.
 *
 * It is safe as a literal in this file because `assets.spec.ts` scans the built
 * bundles, and no test file is bundled. Anything under `src/` would fail that scan,
 * which is the point of keeping it here.
 */
export const POISON =
  'upstream https://gateway.thegraph.com/api/0123456789abcdef0123456789abcdef/subgraphs/id/EXAMPLE failed'

/** Called with the route and the names the page really asked about. */
export type CheckResponder = (route: Route, names: readonly string[]) => Promise<void>

/** Routes the check endpoint. Register before the click that triggers a check. */
export async function stubCheck(page: Page, respond: CheckResponder): Promise<void> {
  await page.route('**/api/check', async (route) => {
    await respond(route, readNames(route))
  })
}

/**
 * The names out of the request body.
 *
 * Read rather than assumed, because "the answer covers exactly what was asked
 * about" is a property of the request as well as the response, and a stub that
 * echoed a list the test wrote would prove nothing about what the page sent.
 */
function readNames(route: Route): readonly string[] {
  const body: { readonly names?: readonly string[] } | null = route.request().postDataJSON()
  return body?.names ?? []
}

/** Answers with a success document. */
export function fulfilCheck(route: Route, document: unknown): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(document),
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' },
  })
}

/** A refusal, in the endpoint's own failure shape. */
export interface Refusal {
  readonly status: number
  readonly code: CheckCode
  /** The endpoint's `message`. The page must not show it, whatever it holds. */
  readonly message?: string
  readonly retryAfterSeconds?: number
}

export function refuseCheck(route: Route, refusal: Refusal): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'cache-control': 'no-store',
  }
  if (refusal.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(refusal.retryAfterSeconds)
  }
  return route.fulfill({
    status: refusal.status,
    headers,
    body: JSON.stringify({
      error: { code: refusal.code, message: refusal.message ?? 'refused' },
      advisory: ADVISORY,
    }),
  })
}

export interface Held {
  /** Await inside a route handler to keep the response unsent. */
  readonly held: Promise<void>
  readonly release: () => void
}

/**
 * A response the test decides when to send.
 *
 * The in-flight state - the button reading `Checking` and disabled, the rows saying
 * a check is running - only exists while a request is outstanding, so it has to be
 * observed rather than raced. The initial `release` throws so a misuse fails loudly
 * instead of silently never resolving.
 */
export function hold(): Held {
  let release = (): void => {
    throw new Error('a held response was released before it was held')
  }
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve()
    }
  })
  return {
    held,
    release: () => {
      release()
    },
  }
}

/** The tick box for one name, named by the label a screen reader hears. */
export function tickBox(page: Page, name: string): Locator {
  return page.getByRole('checkbox', { name: `Fresh check ${name}` })
}

/** The action. Its name changes to `Checking` while a check is in flight. */
export function checkButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Check these now' })
}

export function checkingButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Checking' })
}

/** One name's row, whichever cells it currently has. */
export function rowFor(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name })
}

/** The row's outbound link, which exists only while a fresh check covers the name. */
export function ensLinkFor(page: Page, name: string): Locator {
  return rowFor(page, name).getByRole('link')
}

/** Every link inside the table, for the case where there must be none. */
export function tableLinks(page: Page): Locator {
  return page.getByRole('table').getByRole('link')
}

/** The failed-check banner, which declares `role="alert"` from `VerifyBar`. */
export function failureBanner(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: 'Fresh check failed' })
}
