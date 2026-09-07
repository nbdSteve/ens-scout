import { describe, expect, it } from 'vitest'
import { mayLinkOut, resolveOutbound } from './gate'
import type { CheckedResult, VerifiedName, VerifiedNames } from './types'

const RESULT: CheckedResult = {
  name: 'aaa.eth',
  label: 'aaa',
  status: 'available',
  expiry: null,
  graceEnds: null,
  premiumEnds: null,
}

function verified(entries: Record<string, VerifiedName>): VerifiedNames {
  return new Map(Object.entries(entries))
}

const CHECKED_AT = new Date('2026-03-01T12:00:00Z')
const EXPIRES_AT = new Date('2026-03-01T12:01:00Z')

const ENTRY: VerifiedName = { result: RESULT, checkedAt: CHECKED_AT, expiresAt: EXPIRES_AT }

describe('resolveOutbound', () => {
  it('allows a name with a current check', () => {
    const verdict = resolveOutbound('aaa.eth', verified({ 'aaa.eth': ENTRY }), CHECKED_AT)
    expect(verdict.allowed).toBe(true)
    expect(verdict.allowed && verdict.verified.checkedAt).toEqual(CHECKED_AT)
  })

  it('allows a name one second before its check expires', () => {
    const verdict = resolveOutbound(
      'aaa.eth',
      verified({ 'aaa.eth': ENTRY }),
      new Date('2026-03-01T12:00:59Z'),
    )
    expect(verdict.allowed).toBe(true)
  })

  /*
   * Exclusive at the stated instant. The answer is current up to the moment it says it
   * stops being one, and at that moment it has stopped.
   */
  it('refuses a name at the exact instant its check expires', () => {
    const verdict = resolveOutbound('aaa.eth', verified({ 'aaa.eth': ENTRY }), EXPIRES_AT)
    expect(verdict).toMatchObject({ allowed: false, reason: 'expired' })
  })

  it('refuses a name after its check expires', () => {
    const verdict = resolveOutbound(
      'aaa.eth',
      verified({ 'aaa.eth': ENTRY }),
      new Date('2026-03-01T13:00:00Z'),
    )
    expect(verdict).toMatchObject({ allowed: false, reason: 'expired' })
  })

  /*
   * The lapsed verdict keeps the entry. The page says the check has lapsed and when it
   * was taken, which it cannot do from a bare refusal, and that is the whole reason
   * 'expired' is a separate reason from 'unverified'.
   */
  it('reports when an expired check was taken', () => {
    const verdict = resolveOutbound('aaa.eth', verified({ 'aaa.eth': ENTRY }), EXPIRES_AT)
    expect(verdict.allowed).toBe(false)
    expect(!verdict.allowed && verdict.reason === 'expired' && verdict.verified.checkedAt).toEqual(
      CHECKED_AT,
    )
  })

  it('refuses a name no check has covered', () => {
    const verdict = resolveOutbound('bbb.eth', verified({ 'aaa.eth': ENTRY }), CHECKED_AT)
    expect(verdict).toEqual({ allowed: false, reason: 'unverified' })
  })

  it('refuses every name when nothing has been checked', () => {
    expect(resolveOutbound('aaa.eth', verified({}), CHECKED_AT)).toEqual({
      allowed: false,
      reason: 'unverified',
    })
  })

  /*
   * The rule that makes the gate worth having: an available status in the snapshot is
   * not evidence, so it opens nothing on its own. There is no parameter that could
   * carry one in.
   */
  it('is decided only by the check, never by the status', () => {
    const registered: VerifiedName = {
      result: { ...RESULT, status: 'registered' },
      checkedAt: CHECKED_AT,
      expiresAt: EXPIRES_AT,
    }
    expect(mayLinkOut('aaa.eth', verified({ 'aaa.eth': registered }), CHECKED_AT)).toBe(true)
    // And the converse: an available name with no check is refused.
    expect(mayLinkOut('aaa.eth', verified({}), CHECKED_AT)).toBe(false)
  })

  /*
   * Each name expires on its own instant. Checking a third name later must not take the
   * first two's links with it, which is why verification is held per name.
   */
  it('expires each name on its own instant', () => {
    const later: VerifiedName = {
      result: { ...RESULT, name: 'bbb.eth', label: 'bbb' },
      checkedAt: new Date('2026-03-01T12:00:30Z'),
      expiresAt: new Date('2026-03-01T12:01:30Z'),
    }
    const now = new Date('2026-03-01T12:01:00Z')
    const names = verified({ 'aaa.eth': ENTRY, 'bbb.eth': later })
    expect(mayLinkOut('aaa.eth', names, now)).toBe(false)
    expect(mayLinkOut('bbb.eth', names, now)).toBe(true)
  })
})
