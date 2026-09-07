import { NAME_SUFFIX } from '../snapshot/contract'

/**
 * The primitive readers every fail-closed parser here is built from.
 *
 * There are two wire formats to read - the published snapshot and one fresh check
 * - and both are untrusted JSON that has to be refused rather than repaired. The
 * rules for reading one field are the same in both, and the strict instant pattern
 * is the one that must not diverge: `internal/ens` re-derives every timestamp as
 * whole-second UTC on both paths, so a reader that tolerated a fractional second
 * or a local offset on one of them would accept a document no publisher can write.
 *
 * `fail` is bound once rather than passed to every call, so each parser keeps
 * raising its own error class. That distinction is load-bearing: the snapshot
 * loader branches on `SnapshotFormatError` to decide whether to delete the local
 * copy, and one shared error class would have made a check's refusal look like a
 * reason to throw away a visitor's offline snapshot.
 */

/** Raises the calling parser's own error. Never returns. */
export type Fail = (message: string) => never

export interface WireReaders {
  readonly asRecord: (value: unknown, what: string) => Record<string, unknown>
  readonly asArray: (value: unknown, what: string) => unknown[]
  readonly asString: (value: unknown, what: string) => string
  readonly asInteger: (value: unknown, what: string) => number
  readonly asCount: (value: unknown, what: string) => number
  readonly asInstant: (value: unknown, what: string) => Date
  readonly asOptionalInstant: (value: unknown, what: string) => Date | null
  readonly asLabel: (value: unknown, what: string) => string
}

/** The readers, each refusing through `fail`. */
export function wireReaders(fail: Fail): WireReaders {
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
   * Parses one canonical timestamp. Go writes UTC with second precision, so
   * anything else - a local offset, a fractional second, an unparseable string -
   * is a document that did not come from this project.
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
   * Mirrors `names.Normalize` (internal/names/load.go) for the fully-qualified
   * form both wire formats carry, and returns the bare label. It is intentionally
   * no stricter: labels may hold any lowercase, dot-free, whitespace-free,
   * control-free text, including non-ASCII.
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

  return {
    asRecord,
    asArray,
    asString,
    asInteger,
    asCount,
    asInstant,
    asOptionalInstant,
    asLabel,
  }
}
