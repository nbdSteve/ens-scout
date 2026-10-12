import { describe, expect, it } from 'vitest'
import { FEATURED_SLOTS, featuredLayout } from './layout'

describe('featuredLayout', () => {
  it('maps rank to one fixed slot and decreasing editorial tiers', () => {
    expect(FEATURED_SLOTS.map((slot) => slot.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(featuredLayout('vex', 1).slot.tier).toBe('dominant')
    expect(featuredLayout('zine', 2).slot.tier).toBe('anchor')
    expect(featuredLayout('midi', 4).slot.tier).toBe('supporting')
    expect(featuredLayout('axon', 12).slot.tier).toBe('rhythm')
    expect(featuredLayout('vex', 1).tierMaxPx).toBeGreaterThan(featuredLayout('zine', 2).tierMaxPx)
    expect(featuredLayout('zine', 2).tierMaxPx).toBeGreaterThan(featuredLayout('midi', 4).tierMaxPx)
    expect(featuredLayout('midi', 4).tierMaxPx).toBeGreaterThan(
      featuredLayout('axon', 12).tierMaxPx,
    )
  })

  it('caps long labels more aggressively without changing their slot', () => {
    const short = featuredLayout('vex', 1)
    const long = featuredLayout('z'.repeat(64), 1)

    expect(long.slot).toBe(short.slot)
    expect(long.fontCapCqw).toBeLessThan(short.fontCapCqw)
    expect(long.tierMaxPx).toBe(short.tierMaxPx)
  })

  it.each([0, 13, 1.5])('refuses rank %s outside the fixed composition', (rank) => {
    expect(() => featuredLayout('vex', rank)).toThrow(RangeError)
  })
})
