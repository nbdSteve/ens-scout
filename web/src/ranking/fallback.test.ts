import { describe, expect, it } from 'vitest'
import { deterministicFallbackScore } from './fallback'

describe('deterministicFallbackScore', () => {
  it('matches committed repository-baseline scores', () => {
    expect(deterministicFallbackScore('zineb')).toBe(860)
    expect(deterministicFallbackScore('alike')).toBe(850)
    expect(deterministicFallbackScore('aahed')).toBe(560)
    expect(deterministicFallbackScore('zinke')).toBe(860)
  })

  it('is stable and penalizes repeated or awkward forms', () => {
    expect(deterministicFallbackScore('vex')).toBe(deterministicFallbackScore('vex'))
    expect(deterministicFallbackScore('vex')).toBeGreaterThan(deterministicFallbackScore('zzzs'))
  })

  it('bounds unusually long synthetic inputs without throwing', () => {
    expect(deterministicFallbackScore('a'.repeat(32))).toBeGreaterThanOrEqual(0)
    expect(deterministicFallbackScore('b'.repeat(64))).toBeLessThanOrEqual(1000)
  })
})
