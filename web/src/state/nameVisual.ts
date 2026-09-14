/**
 * A stable decorative identity for one name.
 *
 * None of these values carries lifecycle meaning. They only place the cell's
 * bloom, choose one accent from the Spectrum palette, and stagger entry motion.
 */

export interface NameVisual {
  readonly xPercent: number
  readonly yPercent: number
  readonly accent: string
  readonly delayMs: number
}

const ACCENTS = ['#d8a7ff', '#9d7cff', '#efb7d8', '#7047e8'] as const

/** FNV-1a over UTF-16 code units, used anywhere the frontend needs a stable hash. */
export function fnv1a(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Maps a fully-qualified name to bounded Spectrum presentation values. */
export function nameVisual(name: string): NameVisual {
  const hash = fnv1a(name)
  const accent = ACCENTS[(hash >>> 16) % ACCENTS.length] ?? ACCENTS[0]
  return {
    xPercent: 14 + (hash % 73),
    yPercent: 12 + ((hash >>> 8) % 77),
    accent,
    delayMs: (hash >>> 24) % 240,
  }
}
