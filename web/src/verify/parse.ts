import { compareNames } from '../format/text'
import { NAME_SUFFIX, isStatus, type Status } from '../snapshot/contract'
import type { ResultDocument } from '../snapshot/types'
import { wireReaders } from '../wire/read'
import { CHECK_AUTHORITY, CHECK_FORMAT_VERSION, CHECK_SOURCE } from './contract'
import type { CheckDocument, CheckedResult, Verification } from './types'

/**
 * Fail-closed parsing of one fresh-check answer.
 *
 * This reader is stricter than the snapshot reader in one way that matters: it
 * knows what it asked for. A check is the evidence a name is offered an outbound
 * registration link on, so an answer that covers a different set than was
 * requested - shorter, longer, substituted, reordered - is refused whole rather
 * than used for the names that happen to line up. The endpoint already proves the
 * same property against its upstream in `sameNames`, and it is proved again here
 * because the endpoint is not the only thing between the two: a proxy, a cache, or
 * a captive portal can answer instead of it.
 *
 * Like the snapshot reader it never classifies. `ens.Classify` decided every status
 * at the `checked_at` instant the answer states, and re-deriving one in the browser
 * would produce a second answer to the question this whole endpoint exists to
 * answer once.
 */
export class CheckFormatError extends Error {
  override readonly name: string = 'CheckFormatError'
}

/**
 * Raised only for a format version this build does not know.
 *
 * Separated for the same reason `SnapshotVersionError` is, and it stays separate
 * from that class rather than sharing a base with it: `useSnapshot` deletes a
 * locally cached snapshot when it sees a `SnapshotFormatError`, and a refused check
 * must never be a reason to throw away a visitor's offline copy.
 */
export class CheckVersionError extends CheckFormatError {
  override readonly name = 'CheckVersionError'

  readonly version: number

  constructor(version: number) {
    super(
      `this site reads check format version ${String(CHECK_FORMAT_VERSION)} but the answer declares version ${String(version)}`,
    )
    this.version = version
  }
}

function fail(message: string): never {
  throw new CheckFormatError(message)
}

/*
 * Bound to this parser's own failure. `src/wire/read.ts` says why these are shared
 * with the snapshot parser and why `fail` is bound rather than passed.
 */
const { asRecord, asArray, asString, asInteger, asInstant, asOptionalInstant, asLabel } =
  wireReaders(fail)

function parseStatus(value: unknown, what: string): Status {
  if (!isStatus(value)) {
    fail(`${what} is not a known lifecycle status: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Reads the covered names.
 *
 * Canonical order is byte-wise ascending with no duplicates, which is what
 * `normalizeCheckNames` produces, and it is checked rather than assumed because it
 * is what makes the index comparison against `results` mean anything.
 */
function parseNames(value: unknown, what: string): string[] {
  const raw = asArray(value, what)
  if (raw.length === 0) {
    fail(`${what} must cover at least one name`)
  }
  const parsed: string[] = []
  let previous = ''
  for (const [index, entry] of raw.entries()) {
    const where = `${what}[${String(index)}]`
    const name = asString(entry, where)
    asLabel(name, where)
    // `compareNames`, never `<`: the endpoint sorts with Go's byte-wise comparison,
    // and UTF-16 order disagrees the moment a label reaches past the basic plane.
    if (index > 0 && compareNames(name, previous) <= 0) {
      fail(
        `${what} must be sorted by name without duplicates: ${JSON.stringify(name)} follows ${JSON.stringify(previous)}`,
      )
    }
    previous = name
    parsed.push(name)
  }
  return parsed
}

function parseResults(value: unknown, what: string, names: readonly string[]): ResultDocument[] {
  const raw = asArray(value, what)
  if (raw.length !== names.length) {
    fail(
      `${what} holds ${String(raw.length)} results but the answer covers ${String(names.length)} names`,
    )
  }
  const results: ResultDocument[] = []
  for (const [index, entry] of raw.entries()) {
    const where = `${what}[${String(index)}]`
    const record = asRecord(entry, where)
    const name = asString(record['name'], `${where}.name`)
    // An index comparison, because both lists are in the same canonical order. It is
    // what proves the status at position i belongs to the name at position i, and
    // therefore that no result has been quietly attached to a different name.
    if (name !== names[index]) {
      fail(`${where}.name is not the name at the same position in the covered set`)
    }

    const result: {
      name: string
      status: Status
      expiry?: string
      grace_ends?: string
      premium_ends?: string
    } = {
      name,
      status: parseStatus(record['status'], `${where}.status`),
    }
    if (record['expiry'] !== undefined) {
      asInstant(record['expiry'], `${where}.expiry`)
      result.expiry = asString(record['expiry'], `${where}.expiry`)
    }
    if (record['grace_ends'] !== undefined) {
      asInstant(record['grace_ends'], `${where}.grace_ends`)
      result.grace_ends = asString(record['grace_ends'], `${where}.grace_ends`)
    }
    if (record['premium_ends'] !== undefined) {
      asInstant(record['premium_ends'], `${where}.premium_ends`)
      result.premium_ends = asString(record['premium_ends'], `${where}.premium_ends`)
    }
    // Nothing derives one boundary from another here, so a grace or premium end with
    // no expiry did not come from `ens.Classify`.
    if (result.expiry === undefined && (result.grace_ends ?? result.premium_ends) !== undefined) {
      fail(`${where} carries a grace or premium end without an expiry`)
    }
    results.push(result)
  }
  return results
}

/** Parses and validates one check answer. Throws CheckFormatError. */
export function parseCheckDocument(value: unknown): CheckDocument {
  const root = asRecord(value, 'check')

  const version = asInteger(root['format_version'], 'check.format_version')
  if (version !== CHECK_FORMAT_VERSION) {
    throw new CheckVersionError(version)
  }

  /*
   * The provenance strings are checked, not merely read. They are how an answer says
   * it came from one live read of the subgraph index rather than from some other
   * source, and an answer that claims something else is not one this page can present
   * as a fresh check of anything.
   */
  const source = asString(root['source'], 'check.source')
  if (source !== CHECK_SOURCE) {
    fail(`check.source is not ${JSON.stringify(CHECK_SOURCE)}: ${JSON.stringify(source)}`)
  }
  const authority = asString(root['authority'], 'check.authority')
  if (authority !== CHECK_AUTHORITY) {
    fail(`check.authority is not ${JSON.stringify(CHECK_AUTHORITY)}: ${JSON.stringify(authority)}`)
  }

  const checkedAt = asString(root['checked_at'], 'check.checked_at')
  const checkTime = asInstant(checkedAt, 'check.checked_at')
  const expiresAt = asString(root['expires_at'], 'check.expires_at')
  const expiryTime = asInstant(expiresAt, 'check.expires_at')
  // An answer that expired before it was taken has no interval in which it is a
  // fresh check, so it cannot be one. Equality is refused with it: the endpoint adds
  // a positive lifetime, so an equal pair is a document no publisher writes.
  if (expiryTime.getTime() <= checkTime.getTime()) {
    fail('check.expires_at does not follow check.checked_at')
  }

  const names = parseNames(root['names'], 'check.names')
  const results = parseResults(root['results'], 'check.results', names)

  // Read and required, and deliberately never rendered. `verify/contract.ts` says
  // why: every sentence about a check is written in this repository.
  const advisory = asString(root['advisory'], 'check.advisory')
  if (advisory === '') {
    fail('check.advisory is required')
  }

  return {
    format_version: version,
    source,
    authority,
    checked_at: checkedAt,
    expires_at: expiresAt,
    names,
    results,
    advisory,
  }
}

/**
 * Checks that an answer covers exactly the names that were asked about.
 *
 * The endpoint normalizes, deduplicates, and sorts a request, so the requested set
 * has to be put in the same shape before it can be compared. Everything this page
 * can ask about came out of a published snapshot and is therefore already
 * normalized, so this only orders and deduplicates.
 */
export function assertCovers(document: CheckDocument, requested: readonly string[]): void {
  const wanted = [...new Set(requested)].sort(compareNames)
  if (wanted.length === 0) {
    fail('a check was made for no names')
  }
  if (document.names.length !== wanted.length) {
    fail(
      `the answer covers ${String(document.names.length)} names but ${String(wanted.length)} were asked about`,
    )
  }
  for (const [index, name] of wanted.entries()) {
    if (document.names[index] !== name) {
      fail(`the answer does not cover ${JSON.stringify(name)}`)
    }
  }
}

/** Builds the view of a validated answer. */
export function toVerification(document: CheckDocument): Verification {
  const results: CheckedResult[] = document.results.map((result) => ({
    name: result.name,
    label: result.name.slice(0, -NAME_SUFFIX.length),
    status: result.status,
    expiry: asOptionalInstant(result.expiry, 'expiry'),
    graceEnds: asOptionalInstant(result.grace_ends, 'grace_ends'),
    premiumEnds: asOptionalInstant(result.premium_ends, 'premium_ends'),
  }))

  return {
    checkedAt: asInstant(document.checked_at, 'check.checked_at'),
    expiresAt: asInstant(document.expires_at, 'check.expires_at'),
    names: document.names,
    results,
  }
}
