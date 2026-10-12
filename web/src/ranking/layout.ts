import { codePointLength } from '../format/text'

export type FeaturedTier = 'dominant' | 'anchor' | 'supporting' | 'rhythm'
export type FeaturedAlign = 'start' | 'center' | 'end'

export interface FeaturedSlot {
  readonly rank: number
  readonly tier: FeaturedTier
  readonly xPercent: number
  readonly yPercent: number
  readonly widthPercent: number
  readonly align: FeaturedAlign
}

/**
 * One fixed editorial composition. Rank chooses the slot; a name never does.
 *
 * The dominant, anchor, supporting, and rhythm tiers have disjoint type
 * ceilings, so decorative hashing cannot make a lower-ranked tier outweigh a
 * higher one.
 */
export const FEATURED_SLOTS: readonly FeaturedSlot[] = [
  { rank: 1, tier: 'dominant', xPercent: 31, yPercent: 27, widthPercent: 38, align: 'center' },
  { rank: 2, tier: 'anchor', xPercent: 2, yPercent: 5, widthPercent: 27, align: 'start' },
  { rank: 3, tier: 'anchor', xPercent: 71, yPercent: 7, widthPercent: 27, align: 'end' },
  { rank: 4, tier: 'supporting', xPercent: 3, yPercent: 65, widthPercent: 24, align: 'start' },
  { rank: 5, tier: 'supporting', xPercent: 73, yPercent: 63, widthPercent: 24, align: 'end' },
  { rank: 6, tier: 'supporting', xPercent: 28, yPercent: 80, widthPercent: 20, align: 'center' },
  { rank: 7, tier: 'supporting', xPercent: 52, yPercent: 82, widthPercent: 20, align: 'center' },
  { rank: 8, tier: 'rhythm', xPercent: 40, yPercent: 3, widthPercent: 20, align: 'center' },
  { rank: 9, tier: 'rhythm', xPercent: 3, yPercent: 34, widthPercent: 22, align: 'start' },
  { rank: 10, tier: 'rhythm', xPercent: 75, yPercent: 35, widthPercent: 22, align: 'end' },
  { rank: 11, tier: 'rhythm', xPercent: 25, yPercent: 58, widthPercent: 20, align: 'center' },
  { rank: 12, tier: 'rhythm', xPercent: 56, yPercent: 57, widthPercent: 20, align: 'center' },
]

const TIER_MAX_PX: Readonly<Record<FeaturedTier, number>> = {
  dominant: 88,
  anchor: 58,
  supporting: 42,
  rhythm: 31,
}

/** Instrument Sans advance at the hero weight, deliberately over-estimated. */
const MEAN_ADVANCE_EM = 0.56

export interface FeaturedLayout {
  readonly slot: FeaturedSlot
  readonly tierMaxPx: number
  /**
   * A container-query-unit cap for the visible label.
   *
   * The component makes each slot a size container, so this remains pure
   * arithmetic while following the actual rendered width. Long synthetic labels
   * reach the readable floor and wrap inside their own slot.
   */
  readonly fontCapCqw: number
}

export function featuredLayout(label: string, rank: number): FeaturedLayout {
  if (!Number.isInteger(rank) || rank < 1 || rank > FEATURED_SLOTS.length) {
    throw new RangeError('featured rank must address one of the twelve editorial slots')
  }
  const slot = FEATURED_SLOTS[rank - 1]
  if (slot === undefined) {
    throw new RangeError('featured rank has no editorial slot')
  }
  const length = Math.max(1, codePointLength(label))
  const fontCapCqw = Math.min(90, 90 / (length * MEAN_ADVANCE_EM))
  return { slot, tierMaxPx: TIER_MAX_PX[slot.tier], fontCapCqw }
}
