import { compareNames } from '../format/text'
import {
  CADENCES,
  FORMAT_VERSION,
  NAME_SUFFIX,
  STATUSES,
  deriveScanAgeSeconds,
  isCadence,
  isStatus,
  type Cadence,
  type Status,
} from './contract'
import type {
  LatestDocument,
  ResultDocument,
  ScanAgeDocument,
  Snapshot,
  SnapshotDocument,
  SnapshotResult,
  SourceListDocument,
} from './types'

/**
 * Fail-closed parsing of a published snapshot.
 *
 * The Go reader rejects a snapshot that is missing, duplicated, reordered,
 * corrupt, or not in canonical form rather than repairing it, and this reader
 * holds the same line for the payload it is handed. Every structural invariant
 * the wire format promises is checked here: the format version, the canonical
 * name ordering, the derived counts, the source totals, and the staleness
 * thresholds. A document that breaks one is a malformed document, and the caller
 * renders an explicit error instead of a half-populated table.
 *
 * What is deliberately *not* checked is the ENS lifecycle: this reader never
 * derives a grace end or a premium end from an expiry, and never decides whether
 * a name is available. `ens.Classify` already did that at the scan time the
 * snapshot records, and second-guessing it in the browser would produce two
 * answers to the same question.
 */
export class SnapshotFormatError extends Error {
  override readonly name: string = 'SnapshotFormatError'
}

/**
 * Raised only for a version this build does not know. It is separated from other
 * malformed input because the honest message differs: a reader that is behind a
 * publisher needs to be redeployed, not retried.
 */
export class SnapshotVersionError extends SnapshotFormatError {
  override readonly name = 'SnapshotVersionError'

  readonly version: number

  constructor(version: number) {
    super(
      `this site reads snapshot format version ${String(FORMAT_VERSION)} but the data declares version ${String(version)}`,
    )
    this.version = version
  }
}

function fail(message: string): never {
  throw new SnapshotFormatError(message)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${what} must be an array`)
  }
  return value
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    fail(`${what} must be a string`)
  }
  return value
}

function asInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${what} must be an integer`)
  }
  return value
}

function asCount(value: unknown, what: string): number {
  const count = asInteger(value, what)
  if (count < 0) {
    fail(`${what} must not be negative`)
  }
  return count
}

/**
 * Parses one canonical timestamp. `internal/snapshot` writes UTC with second
 * precision, so anything else - a local offset, a fractional second, an
 * unparseable string - is a document that did not come from the publisher.
 */
function asInstant(value: unknown, what: string): Date {
  const text = asString(value, what)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) {
    fail(`${what} must be a UTC timestamp with second precision, got ${JSON.stringify(text)}`)
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) {
    fail(`${what} is not a real instant: ${JSON.stringify(text)}`)
  }
  return parsed
}

function asOptionalInstant(value: unknown, what: string): Date | null {
  if (value === undefined || value === null) {
    return null
  }
  return asInstant(value, what)
}

/**
 * Mirrors `names.Normalize` (internal/names/load.go) for the fully-qualified form
 * a snapshot stores. It is intentionally no stricter: labels may hold any
 * lowercase, dot-free, whitespace-free, control-free text, including non-ASCII.
 */
function asLabel(value: unknown, what: string): string {
  const name = asString(value, what)
  if (!name.endsWith(NAME_SUFFIX)) {
    fail(`${what} must be a ${NAME_SUFFIX} name, got ${JSON.stringify(name)}`)
  }
  const label = name.slice(0, -NAME_SUFFIX.length)
  if (label === '') {
    fail(`${what} has an empty label`)
  }
  if (label.includes('.')) {
    fail(`${what} must be a second-level name, got ${JSON.stringify(name)}`)
  }
  if (label !== label.toLowerCase()) {
    fail(`${what} must be lowercase, got ${JSON.stringify(name)}`)
  }
  if (/\s/u.test(label)) {
    fail(`${what} contains whitespace`)
  }
  // The same range unicode.IsControl accepts: C0, DEL, and C1. Matching control
  // characters is the intent here, so the rule against it is waived.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(label)) {
    fail(`${what} contains control characters`)
  }
  return label
}

function parseSnapshotId(value: unknown, what: string): string {
  const id = asString(value, what)
  // Mirrors snapshot.ValidateSnapshotID: lowercase letters, digits, inner dashes.
  if (id === '' || id.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    fail(`${what} must be a short lowercase token, got ${JSON.stringify(id)}`)
  }
  return id
}

function parseStatus(value: unknown, what: string): Status {
  if (!isStatus(value)) {
    fail(`${what} is not a known lifecycle status: ${JSON.stringify(value)}`)
  }
  return value
}

function parseCadence(value: unknown, what: string): Cadence {
  if (!isCadence(value)) {
    fail(`${what} is not a known scan cadence: ${JSON.stringify(value)}`)
  }
  return value
}

function parseCounts(value: unknown, what: string): Record<Status, number> {
  const record = asRecord(value, what)
  const counts = {} as Record<Status, number>
  for (const status of STATUSES) {
    if (!(status in record)) {
      fail(`${what} is missing status ${JSON.stringify(status)}`)
    }
    counts[status] = asCount(record[status], `${what}.${status}`)
  }
  // Every result lands in exactly one status, so an extra key means the summary
  // was written by something that does not share this status set.
  for (const key of Object.keys(record)) {
    if (!isStatus(key)) {
      fail(`${what} holds unknown status ${JSON.stringify(key)}`)
    }
  }
  return counts
}

/**
 * Parses the source lists and checks each one's own last-scanned instant against
 * the snapshot's scan time.
 *
 * Every list carries the instant it was really queried at, and a publisher that
 * scans one group carries the other group's instant forward unchanged, so a
 * carried instant is older than the snapshot's scan time and a scanned one equals
 * it. Two rules follow, and both fail closed. No list may claim an instant after
 * the scan time, because nothing in the snapshot was checked after it. And at
 * least one list must have been scanned at it, because a snapshot whose scan time
 * belongs to no list would let every list read as carried and the snapshot-wide
 * age describe a scan that never happened.
 *
 * Nothing here substitutes the scan time for a missing instant. That substitution
 * is the defect this field exists to remove: it made a list whose own schedule had
 * stopped report the freshness of whichever group was still publishing.
 */
function parseSources(value: unknown, what: string, scannedAt: Date): SourceListDocument[] {
  const raw = asArray(value, what)
  if (raw.length === 0) {
    fail(`${what} must list at least one source list`)
  }
  const sources: SourceListDocument[] = []
  let previousId = ''
  let scannedNow = false
  for (const [index, entry] of raw.entries()) {
    const where = `${what}[${String(index)}]`
    const record = asRecord(entry, where)
    const id = asString(record['id'], `${where}.id`)
    if (id === '') {
      fail(`${where}.id is required`)
    }
    const path = asString(record['path'], `${where}.path`)
    if (path === '') {
      fail(`${where}.path is required`)
    }
    // The publisher sorts source lists by id, so a client that renders them in
    // wire order gets a stable order for free. Out-of-order input is malformed.
    // Compared the publisher's way, for the reason `compareNames` documents.
    if (index > 0 && compareNames(id, previousId) <= 0) {
      fail(
        `${what} must be sorted by id without duplicates: ${JSON.stringify(id)} follows ${JSON.stringify(previousId)}`,
      )
    }
    previousId = id
    const lastScannedAt = asString(record['last_scanned_at'], `${where}.last_scanned_at`)
    const instant = asInstant(lastScannedAt, `${where}.last_scanned_at`)
    if (instant.getTime() > scannedAt.getTime()) {
      fail(`${where}.last_scanned_at is after the snapshot scan time`)
    }
    if (instant.getTime() === scannedAt.getTime()) {
      scannedNow = true
    }
    sources.push({
      id,
      path,
      cadence: parseCadence(record['cadence'], `${where}.cadence`),
      names: asCount(record['names'], `${where}.names`),
      last_scanned_at: lastScannedAt,
    })
  }
  if (!scannedNow) {
    fail(`${what} holds no list that was scanned at the snapshot scan time`)
  }
  return sources
}

function parseScanAge(value: unknown, what: string, cadences: readonly Cadence[]): ScanAgeDocument {
  const record = asRecord(value, what)
  const scanAge: ScanAgeDocument = {
    expected_interval_seconds: asInteger(
      record['expected_interval_seconds'],
      `${what}.expected_interval_seconds`,
    ),
    stale_after_seconds: asInteger(record['stale_after_seconds'], `${what}.stale_after_seconds`),
  }
  const derived = deriveScanAgeSeconds(cadences)
  if (derived === null) {
    fail(`${what} cannot be checked without a source cadence`)
  }
  // The thresholds are derived from the cadences, so a payload that disagrees has
  // either been edited or was written against a different contract.
  if (
    scanAge.expected_interval_seconds !== derived.expectedIntervalSeconds ||
    scanAge.stale_after_seconds !== derived.staleAfterSeconds
  ) {
    fail(`${what} disagrees with the source cadences`)
  }
  return scanAge
}

function parseResults(value: unknown, what: string): ResultDocument[] {
  const raw = asArray(value, what)
  const results: ResultDocument[] = []
  let previousName = ''
  for (const [index, entry] of raw.entries()) {
    const where = `${what}[${String(index)}]`
    const record = asRecord(entry, where)
    const name = asString(record['name'], `${where}.name`)
    asLabel(name, `${where}.name`)
    // Canonical order is byte-wise ascending name with no duplicates, which is
    // what lets the browser sort, filter, and page without re-deriving identity.
    // `compareNames` is that order; `<=` is UTF-16 order and would refuse a
    // canonical snapshot the moment a label reached past the basic plane.
    if (index > 0 && compareNames(name, previousName) <= 0) {
      fail(
        `${what} must be sorted by name without duplicates: ${JSON.stringify(name)} follows ${JSON.stringify(previousName)}`,
      )
    }
    previousName = name

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
    // A grace or premium end with no expiry has nothing to have been derived
    // from, so it cannot have come from ens.Classify.
    if (result.expiry === undefined && (result.grace_ends ?? result.premium_ends) !== undefined) {
      fail(`${where} carries a grace or premium end without an expiry`)
    }
    results.push(result)
  }
  return results
}

/** Parses and validates a snapshot document. Throws SnapshotFormatError. */
export function parseSnapshotDocument(value: unknown): SnapshotDocument {
  const root = asRecord(value, 'snapshot')
  const metadata = asRecord(root['metadata'], 'snapshot.metadata')

  const version = asInteger(metadata['format_version'], 'snapshot.metadata.format_version')
  if (version !== FORMAT_VERSION) {
    throw new SnapshotVersionError(version)
  }

  /*
   * Validated here as an instant and kept as the wire string, the same way a result's
   * expiry is. `toSnapshot` parses it again, and a document that passed this function
   * is treated as accepted from then on - it is what gets stored locally as the offline
   * fallback. Checking it only in `toSnapshot` left a payload that parsed but could not
   * resolve, which is a document nothing downstream expects to have to cope with.
   */
  const scannedAt = asString(metadata['scanned_at'], 'snapshot.metadata.scanned_at')
  const scanTime = asInstant(scannedAt, 'snapshot.metadata.scanned_at')

  const sources = parseSources(metadata['sources'], 'snapshot.metadata.sources', scanTime)
  const scanAge = parseScanAge(
    metadata['scan_age'],
    'snapshot.metadata.scan_age',
    sources.map((source) => source.cadence),
  )
  const results = parseResults(root['results'], 'snapshot.results')
  const counts = parseCounts(metadata['counts'], 'snapshot.metadata.counts')
  const names = asCount(metadata['names'], 'snapshot.metadata.names')

  if (names !== results.length) {
    fail(
      `snapshot.metadata.names reports ${String(names)} names but the snapshot holds ${String(results.length)} results`,
    )
  }
  const sourceNames = sources.reduce((total, source) => total + source.names, 0)
  if (sourceNames !== results.length) {
    fail(
      `snapshot.metadata.sources account for ${String(sourceNames)} names but the snapshot holds ${String(results.length)} results`,
    )
  }

  const tally = {} as Record<Status, number>
  for (const status of STATUSES) {
    tally[status] = 0
  }
  for (const result of results) {
    tally[result.status] += 1
  }
  for (const status of STATUSES) {
    if (counts[status] !== tally[status]) {
      fail(
        `snapshot.metadata.counts reports ${String(counts[status])} ${status} results but the snapshot holds ${String(tally[status])}`,
      )
    }
  }

  return {
    metadata: {
      format_version: version,
      snapshot_id: parseSnapshotId(metadata['snapshot_id'], 'snapshot.metadata.snapshot_id'),
      scanned_at: scannedAt,
      sources,
      scan_age: scanAge,
      names,
      counts,
    },
    results,
  }
}

/** Parses and validates a latest pointer document. Throws SnapshotFormatError. */
export function parseLatestDocument(value: unknown): LatestDocument {
  const root = asRecord(value, 'latest')
  const version = asInteger(root['format_version'], 'latest.format_version')
  if (version !== FORMAT_VERSION) {
    throw new SnapshotVersionError(version)
  }

  /*
   * The scan time is read before the sources, because each source's own instant is
   * only meaningful against it. Reading the sources first would need the pointer's
   * scan time to be validated twice or checked afterwards, and a check that runs
   * after the value it guards has already been accepted is the shape this parser
   * avoids everywhere else.
   */
  const scannedAt = asInstant(root['scanned_at'], 'latest.scanned_at')
  const publishedAt = asInstant(root['published_at'], 'latest.published_at')
  if (publishedAt.getTime() < scannedAt.getTime()) {
    fail('latest.published_at precedes latest.scanned_at')
  }

  const sources = parseSources(root['sources'], 'latest.sources', scannedAt)
  const counts = parseCounts(root['counts'], 'latest.counts')
  const names = asCount(root['names'], 'latest.names')
  const sourceNames = sources.reduce((total, source) => total + source.names, 0)
  if (sourceNames !== names) {
    fail(
      `latest.sources account for ${String(sourceNames)} names but the pointer reports ${String(names)}`,
    )
  }
  let counted = 0
  for (const status of STATUSES) {
    counted += counts[status]
  }
  if (counted !== names) {
    fail(`latest.counts sum to ${String(counted)} but the pointer reports ${String(names)} names`)
  }

  const checksum = asString(root['checksum'], 'latest.checksum')
  const compressedChecksum = asString(root['compressed_checksum'], 'latest.compressed_checksum')
  for (const [what, digest] of [
    ['latest.checksum', checksum],
    ['latest.compressed_checksum', compressedChecksum],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      fail(`${what} must be a hex SHA-256 digest`)
    }
  }

  return {
    format_version: version,
    snapshot_id: parseSnapshotId(root['snapshot_id'], 'latest.snapshot_id'),
    scanned_at: asString(root['scanned_at'], 'latest.scanned_at'),
    published_at: asString(root['published_at'], 'latest.published_at'),
    checksum,
    compressed_checksum: compressedChecksum,
    raw_bytes: asCount(root['raw_bytes'], 'latest.raw_bytes'),
    compressed_bytes: asCount(root['compressed_bytes'], 'latest.compressed_bytes'),
    chunk_count: asCount(root['chunk_count'], 'latest.chunk_count'),
    names,
    counts,
    sources,
    scan_age: parseScanAge(
      root['scan_age'],
      'latest.scan_age',
      sources.map((source) => source.cadence),
    ),
  }
}

/**
 * Checks that a pointer and a snapshot describe the same scan. `snapshot.Verify`
 * does this against the stored bytes; the browser can only compare the summary it
 * was given, which is still enough to catch a pointer and a body that came from
 * different scans.
 */
export function assertPointerMatches(document: SnapshotDocument, pointer: LatestDocument): void {
  if (pointer.snapshot_id !== document.metadata.snapshot_id) {
    fail(
      `the latest pointer names snapshot ${JSON.stringify(pointer.snapshot_id)} but the body holds ${JSON.stringify(document.metadata.snapshot_id)}`,
    )
  }
  if (pointer.scanned_at !== document.metadata.scanned_at) {
    fail(`the latest pointer scan time disagrees with the snapshot body`)
  }
  if (pointer.names !== document.metadata.names) {
    fail(`the latest pointer name count disagrees with the snapshot body`)
  }
  // Each list's own instant is what every per-list warning resolves against, and
  // the pointer repeats it, so a disagreement here would let the disclosure and
  // the summary describe two different scans of the same list.
  if (pointer.sources.length !== document.metadata.sources.length) {
    fail(`the latest pointer lists a different number of source lists than the snapshot body`)
  }
  for (const [index, source] of document.metadata.sources.entries()) {
    const declared = pointer.sources[index]
    if (declared === undefined) {
      fail(`the latest pointer is missing source list ${JSON.stringify(source.id)}`)
    }
    if (declared.id !== source.id || declared.last_scanned_at !== source.last_scanned_at) {
      fail(`the latest pointer source lists disagree with the snapshot body`)
    }
  }
}

/** Builds the browse-ready view of a validated document. */
export function toSnapshot(
  document: SnapshotDocument,
  pointer: LatestDocument | null = null,
): Snapshot {
  const results: SnapshotResult[] = document.results.map((result) => {
    const label = result.name.slice(0, -NAME_SUFFIX.length)
    return {
      name: result.name,
      label,
      status: result.status,
      expiry: asOptionalInstant(result.expiry, 'expiry'),
      graceEnds: asOptionalInstant(result.grace_ends, 'grace_ends'),
      premiumEnds: asOptionalInstant(result.premium_ends, 'premium_ends'),
    }
  })

  return {
    metadata: {
      snapshotId: document.metadata.snapshot_id,
      scannedAt: asInstant(document.metadata.scanned_at, 'snapshot.metadata.scanned_at'),
      sources: document.metadata.sources.map((source) => ({
        id: source.id,
        path: source.path,
        cadence: source.cadence,
        names: source.names,
        lastScannedAt: asInstant(source.last_scanned_at, `source ${source.id} last_scanned_at`),
      })),
      expectedIntervalSeconds: document.metadata.scan_age.expected_interval_seconds,
      staleAfterSeconds: document.metadata.scan_age.stale_after_seconds,
      names: document.metadata.names,
      counts: { ...document.metadata.counts },
    },
    results,
    publishedAt: pointer === null ? null : asInstant(pointer.published_at, 'latest.published_at'),
  }
}

/** Every cadence in this snapshot, in `CADENCES` order. */
export function snapshotCadences(sources: readonly { cadence: Cadence }[]): Cadence[] {
  const present = new Set(sources.map((source) => source.cadence))
  return CADENCES.filter((cadence) => present.has(cadence))
}
