import { codePointLength } from '../format/text'
import type { SnapshotResult, SourceList } from './types'

/**
 * Which source list a result came from.
 *
 * The snapshot does not record this. Each source list carries only its id, its
 * path, its cadence, and how many names it contributed, so per-name attribution
 * has to be inferred - and an inference that quietly guesses wrong would make
 * the source-list filter lie about which list a name is on.
 *
 * So this module infers and then *proves* the inference. Every list in this
 * project is a fixed-length word list, and its path and id both state the
 * length (`data/words/4-letters.txt`, `four-letters`). Bucketing results by
 * label length therefore reproduces the lists exactly - and the reproduction is
 * checked against the `names` count each source declared. If a single bucket
 * disagrees, attribution is refused for the whole snapshot and the interface
 * hides the control rather than offering a filter it cannot honour.
 */

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

/**
 * The label length a source list is named for, from its path or its id. The path
 * uses digits (`4-letters.txt`) and the id uses words (`four-letters`), so both
 * spellings are accepted.
 */
export function declaredLabelLength(source: SourceList): number | null {
  for (const text of [source.path, source.id]) {
    const digits = /(?:^|[^0-9])([0-9]{1,2})-letters?(?![a-z])/.exec(text)
    if (digits?.[1] !== undefined) {
      return Number.parseInt(digits[1], 10)
    }
    const words = /(?:^|[^a-z])([a-z]+)-letters?(?![a-z])/.exec(text)
    const word = words?.[1]
    if (word !== undefined && word in NUMBER_WORDS) {
      return NUMBER_WORDS[word] ?? null
    }
  }
  return null
}

export interface Attribution {
  /** True when every result is attributed to exactly one source list. */
  readonly available: boolean
  /** Why attribution was refused, for the interface to show. Null when available. */
  readonly reason: string | null
  /** Source id for each fully-qualified name. Empty when unavailable. */
  readonly sourceIdByName: ReadonlyMap<string, string>
  /** Label length each source list is named for. Empty when unavailable. */
  readonly lengthBySourceId: ReadonlyMap<string, number>
}

const UNAVAILABLE = (reason: string): Attribution => ({
  available: false,
  reason,
  sourceIdByName: new Map(),
  lengthBySourceId: new Map(),
})

/** Infers and verifies per-name source attribution. */
export function deriveAttribution(
  sources: readonly SourceList[],
  results: readonly SnapshotResult[],
): Attribution {
  const lengthBySourceId = new Map<string, number>()
  const sourceIdByLength = new Map<number, string>()
  for (const source of sources) {
    const length = declaredLabelLength(source)
    if (length === null) {
      return UNAVAILABLE(`source list ${source.id} does not state a label length`)
    }
    const existing = sourceIdByLength.get(length)
    if (existing !== undefined) {
      return UNAVAILABLE(
        `source lists ${existing} and ${source.id} both cover ${String(length)}-letter labels`,
      )
    }
    sourceIdByLength.set(length, source.id)
    lengthBySourceId.set(source.id, length)
  }

  const sourceIdByName = new Map<string, string>()
  const tally = new Map<string, number>()
  for (const result of results) {
    const length = codePointLength(result.label)
    const sourceId = sourceIdByLength.get(length)
    if (sourceId === undefined) {
      return UNAVAILABLE(`no source list covers the ${String(length)}-letter label ${result.label}`)
    }
    sourceIdByName.set(result.name, sourceId)
    tally.set(sourceId, (tally.get(sourceId) ?? 0) + 1)
  }

  for (const source of sources) {
    const counted = tally.get(source.id) ?? 0
    if (counted !== source.names) {
      return UNAVAILABLE(
        `source list ${source.id} declares ${String(source.names)} names but ${String(counted)} results match it`,
      )
    }
  }

  return { available: true, reason: null, sourceIdByName, lengthBySourceId }
}
