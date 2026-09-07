import { describe, expect, it } from 'vitest'
import type { SnapshotResult } from '../snapshot/types'
import type { VerifiedName } from '../verify/types'
import { rowVerification, rowVerifyNote, type VerifyBinding } from './verification'

/**
 * The per-row derivation, on its own.
 *
 * Both cells of a row read one `RowVerification`, so a disagreement between the link
 * and the fresh status would be a bug in exactly one function. These tests are that
 * function's, and `ResultsTable.test.tsx` proves the cells really read it.
 */

const CHECKED_AT = new Date('2026-03-01T12:00:00Z')
const EXPIRES_AT = new Date('2026-03-01T12:01:00Z')

const result: SnapshotResult = {
  name: 'aaaa.eth',
  label: 'aaaa',
  status: 'available',
  expiry: null,
  graceEnds: null,
  premiumEnds: null,
}

const entry: VerifiedName = { result, checkedAt: CHECKED_AT, expiresAt: EXPIRES_AT }

function binding(overrides: Partial<VerifyBinding> = {}): VerifyBinding {
  return {
    selected: new Set<string>(),
    full: false,
    pending: new Set<string>(),
    verified: new Map<string, VerifiedName>(),
    onToggle: () => undefined,
    ...overrides,
  }
}

describe('rowVerification selection', () => {
  it('reports a ticked name as selected and an unticked one as not', () => {
    const bound = binding({ selected: new Set(['aaaa.eth']) })

    expect(rowVerification('aaaa.eth', bound, CHECKED_AT).selected).toBe(true)
    expect(rowVerification('bbbb.eth', bound, CHECKED_AT).selected).toBe(false)
  })

  /*
   * The bound has to stop a name being added without stopping one being taken away.
   * A visitor who has ticked the maximum and wants a different name must be able to
   * untick one, so `selectable` follows the tick rather than the bound alone.
   */
  it('keeps a ticked name selectable when the selection is full', () => {
    const bound = binding({ selected: new Set(['aaaa.eth']), full: true })

    expect(rowVerification('aaaa.eth', bound, CHECKED_AT).selectable).toBe(true)
    expect(rowVerification('bbbb.eth', bound, CHECKED_AT).selectable).toBe(false)
  })

  it('keeps every name selectable while the selection is not full', () => {
    const bound = binding({ selected: new Set(['aaaa.eth']) })

    expect(rowVerification('bbbb.eth', bound, CHECKED_AT).selectable).toBe(true)
  })

  it('reports only the names the running check covers as pending', () => {
    const bound = binding({ pending: new Set(['aaaa.eth']) })

    expect(rowVerification('aaaa.eth', bound, CHECKED_AT).pending).toBe(true)
    expect(rowVerification('bbbb.eth', bound, CHECKED_AT).pending).toBe(false)
  })
})

describe('rowVerification verdict', () => {
  it('carries the gate verdict rather than deciding again', () => {
    const bound = binding({ verified: new Map([['aaaa.eth', entry]]) })

    expect(rowVerification('aaaa.eth', bound, CHECKED_AT).verdict).toEqual({
      allowed: true,
      verified: entry,
    })
    expect(rowVerification('aaaa.eth', bound, EXPIRES_AT).verdict).toEqual({
      allowed: false,
      reason: 'expired',
      verified: entry,
    })
    expect(rowVerification('bbbb.eth', bound, CHECKED_AT).verdict).toEqual({
      allowed: false,
      reason: 'unverified',
    })
  })

  /*
   * Ticking a name is a request, not evidence. Nothing about the selection may open the
   * gate, or a visitor could reach the ENS app by ticking a box and pressing nothing.
   */
  it('opens the gate for no reason other than a current check', () => {
    const bound = binding({ selected: new Set(['aaaa.eth']), pending: new Set(['aaaa.eth']) })

    expect(rowVerification('aaaa.eth', bound, CHECKED_AT).verdict.allowed).toBe(false)
  })
})

describe('rowVerifyNote', () => {
  const cases: readonly (readonly [string, VerifyBinding, Date, string | null])[] = [
    [
      'says nothing when a current check has already spoken through the link',
      binding({ verified: new Map([['aaaa.eth', entry]]) }),
      CHECKED_AT,
      null,
    ],
    ['asks for a check when none has covered the name', binding(), CHECKED_AT, 'No fresh check'],
    [
      'says the check has lapsed rather than that there was none',
      binding({ verified: new Map([['aaaa.eth', entry]]) }),
      EXPIRES_AT,
      'Fresh check has lapsed',
    ],
    [
      'reports a running check ahead of anything it may replace',
      binding({ pending: new Set(['aaaa.eth']), verified: new Map([['aaaa.eth', entry]]) }),
      EXPIRES_AT,
      'Fresh check running',
    ],
  ]

  it.each(cases)('%s', (_name, bound, now, expected) => {
    expect(rowVerifyNote(rowVerification('aaaa.eth', bound, now))).toBe(expected)
  })
})
