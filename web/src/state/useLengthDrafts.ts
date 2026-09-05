import { useMemo } from 'react'
import { boundNotApplied, readLengthBound, type BoundEnd, type LengthRange } from './query'
import { useDraft, type Draft } from './useDraft'

/**
 * The two length boxes, and what they are holding that is not filtering anything.
 *
 * These drafts sit above the toolbar rather than inside it because two things need them:
 * the boxes, and the advisory above the list. The condition the advisory reports is a box
 * holding content that names no label length, and that is all it is - it makes no
 * difference whether the visitor typed `100`, `3.5` or `-3`, and it cannot be read back
 * out of the URL, because a value the parser refused was never written to it. Deriving
 * the notice from the URL is what made it appear once and then vanish on the next
 * unrelated keystroke, while the box carried on showing a number that filtered nothing.
 *
 * So the notice lasts exactly as long as the mismatch does. It survives a search
 * keystroke, a sort change, a status tick and a back navigation, and it goes when the
 * visitor corrects the value, empties the box, or follows a link that clears the filters.
 */
export interface LengthDrafts {
  readonly min: Draft
  readonly max: Draft
  /** One line per box holding something that is not a label length. */
  readonly advisories: readonly string[]
}

/** What a bound looks like in its box. No bound is an empty box, never a zero. */
export function boundText(value: number | null): string {
  return value === null ? '' : String(value)
}

function advise(end: BoundEnd, text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '' || readLengthBound(trimmed) !== null) {
    return null
  }
  return boundNotApplied(end, trimmed)
}

export function useLengthDrafts(length: LengthRange): LengthDrafts {
  const min = useDraft(boundText(length.min))
  const max = useDraft(boundText(length.max))

  const advisories = useMemo(() => {
    const found: string[] = []
    for (const [end, text] of [
      ['min', min.text],
      ['max', max.text],
    ] as const) {
      const message = advise(end, text)
      if (message !== null) {
        found.push(message)
      }
    }
    return found
  }, [min.text, max.text])

  return { min, max, advisories }
}
