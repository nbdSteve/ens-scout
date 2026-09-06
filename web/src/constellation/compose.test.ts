import { describe, expect, it } from 'vitest'

import {
  composeBands,
  composeName,
  DESKTOP_SCALE,
  fnv1a,
  MOBILE_SCALE,
  type Scale,
} from './compose'

/**
 * The composition is the page's whole layout decision, so it is tested as
 * arithmetic: determinism, the status salt, the width cap, and the band deal.
 * None of it needs a browser, which is the reason it lives in a pure module.
 */

/** A band wide enough that the cap never binds, so the bucket is what is seen. */
const ROOMY_BAND_PX = 4000

function repeat(character: string, count: number): string {
  return character.repeat(count)
}

describe('fnv1a', () => {
  it('is stable and spread across similar inputs', () => {
    expect(fnv1a('zap')).toBe(fnv1a('zap'))
    expect(fnv1a('zap')).not.toBe(fnv1a('zaq'))
    expect(fnv1a('')).toBe(2166136261)
  })
})

describe('composeName', () => {
  it('gives the same label and status the same composition every time', () => {
    const first = composeName('zap', 'available', ROOMY_BAND_PX)
    const second = composeName('zap', 'available', ROOMY_BAND_PX)
    expect(second).toEqual(first)
  })

  it('recomposes the same label when its status changes, so a view switch is visible', () => {
    const available = composeName('zap', 'available', ROOMY_BAND_PX)
    const premium = composeName('zap', 'premium', ROOMY_BAND_PX)
    expect(premium).not.toEqual(available)
  })

  it('draws its size, air, and rhythm from the approved tables', () => {
    // Independent slices of one hash, so the three never lock into step.
    const sizes = new Set<number>()
    const tucks = new Set<number>()
    const lifts = new Set<number>()
    for (let index = 0; index < 400; index += 1) {
      const style = composeName(`name${String(index)}`, 'available', ROOMY_BAND_PX)
      sizes.add(style.sizePx)
      tucks.add(style.tuckPx)
      lifts.add(style.liftPx)
      expect(style.depth).toBeGreaterThanOrEqual(1)
      expect(style.depth).toBeLessThanOrEqual(5)
    }
    expect(sizes.size).toBe(12)
    expect(tucks.size).toBe(12)
    expect(lifts.size).toBe(12)
  })

  it('scales the whole composition down on mobile', () => {
    const desktop = composeName('zap', 'available', ROOMY_BAND_PX, DESKTOP_SCALE)
    const mobile = composeName('zap', 'available', ROOMY_BAND_PX, MOBILE_SCALE)
    expect(mobile.sizePx).toBeCloseTo(desktop.sizePx * MOBILE_SCALE.size, 6)
    expect(mobile.tuckPx).toBeCloseTo(desktop.tuckPx * MOBILE_SCALE.tuck, 6)
    expect(mobile.liftPx).toBeCloseTo(desktop.liftPx * MOBILE_SCALE.lift, 6)
    expect(mobile.depth).toBe(desktop.depth)
  })

  const bands: readonly {
    readonly name: string
    readonly widthPx: number
    readonly scale: Scale
  }[] = [
    { name: 'a desktop band', widthPx: 742, scale: DESKTOP_SCALE },
    { name: 'a narrow desktop band', widthPx: 400, scale: DESKTOP_SCALE },
    { name: 'a mobile band', widthPx: 296, scale: MOBILE_SCALE },
  ]

  for (const band of bands) {
    it(`keeps a 32 and a 64 character label inside ${band.name}`, () => {
      for (const length of [32, 64]) {
        const label = repeat('m', length)
        const style = composeName(label, 'available', band.widthPx, band.scale)
        // The estimated run has to fit, unless the floor has taken over.
        const fits = style.sizePx * length * 0.54 <= band.widthPx + 0.001
        expect(fits || style.sizePx === band.scale.minSizePx).toBe(true)
        expect(style.sizePx).toBeGreaterThanOrEqual(band.scale.minSizePx)
      }
    })
  }

  it('never lets the cap push a name below the floor', () => {
    const style = composeName(repeat('m', 64), 'available', 10, DESKTOP_SCALE)
    expect(style.sizePx).toBe(DESKTOP_SCALE.minSizePx)
  })

  it('measures the cap in code points, so an astral character counts once', () => {
    // Sixteen musical symbols: sixteen glyphs, but thirty-two UTF-16 code units.
    const astral = repeat('\u{1D11E}', 16)
    expect(astral.length).toBe(32)
    const plain = repeat('m', 16)
    const wide = 200
    expect(composeName(astral, 'available', wide).sizePx).toBeCloseTo(
      // Same glyph count, so the cap is the same; only the bucket may differ.
      Math.min(composeName(astral, 'available', 1e6).sizePx, wide / (16 * 0.54)),
      6,
    )
    expect(composeName(plain, 'available', wide).sizePx).toBeLessThanOrEqual(wide / (16 * 0.54))
  })

  it('never returns a size a browser would reject', () => {
    for (let index = 0; index < 200; index += 1) {
      const style = composeName(repeat('x', (index % 64) + 1), 'premium', 300, MOBILE_SCALE)
      expect(Number.isFinite(style.sizePx)).toBe(true)
      expect(style.sizePx).toBeGreaterThan(0)
    }
  })
})

describe('composeBands', () => {
  function names(count: number): string[] {
    return Array.from(
      { length: count },
      (_unused, index) => `name-${String(index).padStart(3, '0')}`,
    )
  }

  it('renders no band at all for an empty page', () => {
    expect(composeBands([], 1440)).toEqual([])
  })

  it('stays between one and eight bands whatever the page size', () => {
    for (const count of [1, 2, 6, 7, 12, 30, 50, 500]) {
      const bands = composeBands(names(count), 1440)
      expect(bands.length).toBeGreaterThanOrEqual(1)
      expect(bands.length).toBeLessThanOrEqual(8)
    }
  })

  it('deals every item once, in the order it was given', () => {
    const page = names(50)
    const dealt = composeBands(page, 1440).flatMap((band) => band.items)
    expect(dealt).toEqual(page)
  })

  it('keeps band sizes within one of each other, so no band is stranded', () => {
    for (const count of [7, 13, 49, 50, 51, 97]) {
      const sizes = composeBands(names(count), 1440).map((band) => band.items.length)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
      expect(sizes.reduce((total, size) => total + size, 0)).toBe(count)
    }
  })

  it('reproduces the approved four indents and widths for a full page at 1440', () => {
    const bands = composeBands(names(50), 1440)
    expect(bands.slice(0, 4).map((band) => band.indentPx)).toEqual([96, 318, 150, 470])
    expect(bands.slice(0, 4).map((band) => band.widthPx)).toEqual([1176, 1046, 1158, 892])
  })

  it('scales the silhouette to the measured column', () => {
    const bands = composeBands(names(50), 720)
    expect(bands[0]?.indentPx).toBe(48)
    expect(bands[0]?.widthPx).toBe(588)
  })

  it('keeps every band inside the column, so no band can widen the page', () => {
    for (const columnPx of [320, 720, 1440, 2560]) {
      for (const band of composeBands(names(50), columnPx)) {
        expect(band.indentPx + band.widthPx).toBeLessThanOrEqual(columnPx)
      }
    }
  })

  it('gives no two bands of a full page the same silhouette', () => {
    const shapes = composeBands(names(50), 1440).map(
      (band) => `${String(band.indentPx)}:${String(band.widthPx)}`,
    )
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  it('depends on band position rather than on contents, so the silhouette is stable', () => {
    const first = composeBands(names(50), 1440).map((band) => band.indentPx)
    const second = composeBands(names(50).reverse(), 1440).map((band) => band.indentPx)
    expect(second).toEqual(first)
  })
})
