import { describe, expect, it } from 'vitest'
import { fnv1a, nameVisual } from './nameVisual'

describe('nameVisual', () => {
  it('returns exactly the same bloom identity for the same name', () => {
    expect(nameVisual('spectrum.eth')).toEqual(nameVisual('spectrum.eth'))
  })

  it('varies names while keeping every decorative value inside its contract', () => {
    const names = ['aura.eth', 'bloom.eth', 'cove.eth', 'prism.eth']
    const visuals = names.map(nameVisual)

    expect(new Set(visuals.map((visual) => JSON.stringify(visual))).size).toBeGreaterThan(1)
    for (const visual of visuals) {
      expect(visual.xPercent).toBeGreaterThanOrEqual(14)
      expect(visual.xPercent).toBeLessThanOrEqual(86)
      expect(visual.yPercent).toBeGreaterThanOrEqual(12)
      expect(visual.yPercent).toBeLessThanOrEqual(88)
      expect(visual.delayMs).toBeGreaterThanOrEqual(0)
      expect(visual.delayMs).toBeLessThan(240)
      expect(visual.accent).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('keeps the shared hash stable for shortlist and bloom seeding', () => {
    expect(fnv1a('ens.eth')).toBe(2_812_644_738)
  })
})
