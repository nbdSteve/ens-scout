import { codePointLength, compareNames } from '../format/text'
import { STATUSES, isStatus, type Status } from '../snapshot/contract'
import type { FixturePayload } from './fixtures'

const PREVIEW_NAMES = [
  'zine.eth',
  'hex.eth',
  'midi.eth',
  'rune.eth',
  'saga.eth',
  'dub.eth',
  'eon.eth',
  'fuzz.eth',
  'jolt.eth',
  'moth.eth',
  'zero.eth',
  'jinx.eth',
  `${'y'.repeat(32)}.eth`,
  `${'z'.repeat(64)}.eth`,
] as const

type MutableRecord = Record<string, unknown>

function record(value: unknown): MutableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const source = value as Readonly<Record<string, unknown>>
  const copy: MutableRecord = {}
  for (const key of Object.keys(source)) {
    copy[key] = source[key]
  }
  return copy
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items = value as unknown[]
  return [...items]
}

function labelLength(name: string): number {
  return codePointLength(name.slice(0, -'.eth'.length))
}

function sourceLength(source: MutableRecord): number | null {
  for (const value of [source['path'], source['id']]) {
    if (typeof value !== 'string') {
      continue
    }
    const match = /(?:^|[^0-9])([0-9]{1,2})-letters?/.exec(value)
    if (match?.[1] !== undefined) {
      return Number.parseInt(match[1], 10)
    }
    const words: Readonly<Record<string, number>> = { three: 3, four: 4, five: 5 }
    const word = /(?:^|[^a-z])(three|four|five)-letters?/.exec(value)?.[1]
    if (word !== undefined) {
      return words[word] ?? null
    }
  }
  return null
}

/**
 * Expands only the built-in preview payload. The committed contract fixture stays
 * untouched; the transformed document still goes through the production parser.
 */
export function densePreview(payload: FixturePayload): FixturePayload {
  const snapshot = record(payload.snapshot)
  const metadata = record(snapshot['metadata'])
  const originalResults = array(snapshot['results']).map(record)
  const existing = new Set(
    originalResults.flatMap((result) => (typeof result.name === 'string' ? [result.name] : [])),
  )
  const additions = PREVIEW_NAMES.filter((name) => !existing.has(name)).map((name) => ({
    name,
    status: 'available',
  }))
  const results = [...originalResults, ...additions].sort((left, right) =>
    compareNames(String(left.name), String(right.name)),
  )

  const scannedAt = metadata['scanned_at']
  const sources = array(metadata['sources']).map(record)
  for (const length of [32, 64]) {
    if (!sources.some((source) => sourceLength(source) === length)) {
      sources.push({
        id: `preview-${String(length)}-letters`,
        path: `web/preview/${String(length)}-letters.txt`,
        cadence: 'daily',
        names: 0,
        last_scanned_at: scannedAt,
      })
    }
  }
  sources.sort((left, right) => compareNames(String(left['id']), String(right['id'])))
  const namesByLength = new Map<number, number>()
  for (const result of results) {
    const name = result.name
    if (typeof name === 'string') {
      const length = labelLength(name)
      namesByLength.set(length, (namesByLength.get(length) ?? 0) + 1)
    }
  }
  for (const source of sources) {
    const length = sourceLength(source)
    if (length !== null) {
      source['names'] = namesByLength.get(length) ?? 0
    }
  }

  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>
  for (const result of results) {
    const status = result.status
    if (isStatus(status)) {
      counts[status] += 1
    }
  }

  const nextMetadata = {
    ...metadata,
    snapshot_id: 'preview-spectrum',
    sources,
    names: results.length,
    counts,
  }
  const latest = record(payload.latest)
  return {
    snapshot: { ...snapshot, metadata: nextMetadata, results },
    latest: {
      ...latest,
      snapshot_id: nextMetadata.snapshot_id,
      sources,
      names: results.length,
      counts,
    },
  }
}
