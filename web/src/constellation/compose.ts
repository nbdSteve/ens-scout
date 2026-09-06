/**
 * The deterministic constellation.
 *
 * Names are the main event, so their arrangement has to be composed rather than
 * laid out on a grid. Every value here is a pure function of the name, its
 * lifecycle status, and the measured column, so the same snapshot always draws
 * the same page: no randomness, no animation state, and nothing that depends on
 * having rendered once already.
 *
 * The hash is salted with the status, which is what makes switching lifecycle
 * view visibly recompose the page instead of reshuffling the same shapes.
 *
 * This module has no DOM dependency, so its determinism is a unit test rather
 * than a screenshot.
 */

import { codePointLength } from '../format/text'

/**
 * FNV-1a over UTF-16 code units, exactly as the approved concept.
 *
 * Code units rather than code points is deliberate: this hash only has to be
 * stable and well spread, and one astral character contributing two rounds
 * costs nothing. Where a count has to mean glyphs - the width cap below - the
 * code point count is used instead.
 */
export function fnv1a(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * The three approved tables.
 *
 * Twelve entries each, indexed by a different slice of the same hash, so size,
 * air, and rhythm vary independently and no two of them can lock into step.
 *
 * Each is typed with a required first element so an index expression is a
 * `number` rather than `number | undefined`: `noUncheckedIndexedAccess` is on,
 * and a modulo index is provably in range without an assertion this way.
 */
type Table = readonly [number, ...number[]]

/** Type size, in px at desktop. */
const SIZE: Table = [96, 34, 60, 44, 80, 32, 52, 70, 38, 88, 56, 42]

/** Trailing air, in px. The overlap comes from the band indents, not from here. */
const TUCK: Table = [22, 40, 12, 50, 28, 8, 34, 16, 56, 10, 30, 6]

/** Baseline nudge, in px, which supplies the rhythm along a band. */
const LIFT: Table = [0, 7, -8, 11, -4, 4, -2, 9, -11, 3, 6, -6]

function pick(table: Table, index: number): number {
  return table[index % table.length] ?? table[0]
}

/** How the tables are scaled, and how small a name may become, at one breakpoint. */
export interface Scale {
  readonly size: number
  readonly tuck: number
  readonly lift: number
  /** Floor for the width cap. Below this a name stops being the visual event. */
  readonly minSizePx: number
}

export const DESKTOP_SCALE: Scale = { size: 1, tuck: 1, lift: 1, minSizePx: 18 }

export const MOBILE_SCALE: Scale = { size: 0.46, tuck: 0.38, lift: 0.45, minSizePx: 14 }

/**
 * Mean advance of the bundled Instrument Sans Variable at weight 700 with the
 * -0.05em tracking the names use, as a fraction of the font size.
 *
 * This only feeds the width cap, and the cap only has to keep a long name inside
 * its band. The value is a deliberate slight over-estimate so the cap errs
 * small, and `overflow-wrap: anywhere` on the name is the second guard, so an
 * under-estimate wraps inside the band rather than widening the page. The
 * browser test at 1440 and at 320 is what actually holds the guarantee.
 */
const ADVANCE = 0.54

/** One composed name. Everything the mark needs, and nothing about the DOM. */
export interface NameStyle {
  readonly sizePx: number
  readonly tuckPx: number
  readonly liftPx: number
  /** 1 to 5. How far the chromatic split is carried on this name. */
  readonly depth: number
}

/**
 * The composition for one name.
 *
 * The size bucket is an upper bound rather than the answer. The snapshot admits
 * labels up to 64 code points, and a 96px bucket at 64 characters is roughly
 * 3,300px against a 742px band, so the bucket is capped by what the band can
 * actually hold and floored at `minSizePx`.
 */
export function composeName(
  label: string,
  status: string,
  bandWidthPx: number,
  scale: Scale = DESKTOP_SCALE,
): NameStyle {
  const hash = fnv1a(label + status)
  const bucket = pick(SIZE, hash) * scale.size
  const length = Math.max(1, codePointLength(label))
  const cap = bandWidthPx / (length * ADVANCE)
  return {
    sizePx: Math.max(scale.minSizePx, Math.min(bucket, cap)),
    tuckPx: pick(TUCK, hash >>> 4) * scale.tuck,
    liftPx: pick(LIFT, hash >>> 8) * scale.lift,
    depth: 1 + ((hash >>> 12) % 5),
  }
}

/**
 * The band silhouette, as px at a reference column.
 *
 * The first four of each are the approved hand-set values, so a full page at
 * 1440 is pixel-identical to the concept, and the next four continue the same
 * rhythm without repeating any earlier pair. Held as reference px rather than as
 * fractions so the seeding stays literal and the identity at 1440 is exact.
 *
 * The tables are indexed by band position, never by a hash, so the page keeps a
 * stable overall silhouette while its contents change.
 */
const REFERENCE_COLUMN_PX = 1440

const INDENT: Table = [96, 318, 150, 470, 260, 70, 390, 190]

const WIDTH: Table = [1176, 1046, 1158, 892, 1100, 1230, 980, 1140]

/** Most names in one band before another is added. */
const NAMES_PER_BAND = 6

/** Bands the silhouette is defined for. */
const MAX_BANDS = 8

/** One band, with the items dealt into it in the order they arrived. */
export interface Band<T> {
  readonly indentPx: number
  readonly widthPx: number
  readonly items: readonly T[]
}

/**
 * Deals a page of items into bands.
 *
 * Items are dealt in the order given, so the DOM order is exactly the sort order
 * the URL asked for. That is what lets the composition be visually asymmetric
 * without costing anything: a screen reader and a keyboard still walk the names
 * in the order the sort promised.
 *
 * Band sizes differ by at most one. Dealing `ceil(count / bandCount)` into each
 * instead would strand the remainder - fifty names would be seven bands of seven
 * and one band of one, which reads as a mistake rather than as a composition.
 *
 * An empty page returns no bands, so nothing renders an empty band.
 */
export function composeBands<T>(items: readonly T[], columnPx: number): readonly Band<T>[] {
  if (items.length === 0) {
    return []
  }
  const bandCount = Math.min(MAX_BANDS, Math.max(1, Math.ceil(items.length / NAMES_PER_BAND)))
  const base = Math.floor(items.length / bandCount)
  const wide = items.length % bandCount
  const ratio = columnPx / REFERENCE_COLUMN_PX
  const bands: Band<T>[] = []
  let taken = 0
  for (let index = 0; index < bandCount; index += 1) {
    const size = base + (index < wide ? 1 : 0)
    bands.push({
      indentPx: pick(INDENT, index) * ratio,
      widthPx: pick(WIDTH, index) * ratio,
      items: items.slice(taken, taken + size),
    })
    taken += size
  }
  return bands
}
