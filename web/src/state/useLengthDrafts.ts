import { useCallback, useMemo, useState } from 'react'
import { boundNotApplied, readLengthBound, type BoundEnd, type LengthRange } from './query'
import { useDraft } from './useDraft'

/**
 * The two length boxes, and what they are holding that is not filtering anything.
 *
 * These drafts sit above the toolbar because two things need them: the boxes, and the
 * advisory above the list. The condition the advisory reports is a box holding content
 * that names no label length, and that is all it is - it makes no difference whether the
 * visitor typed `100`, `3.5`, `-3`, or a `.` the browser could not read at all, and it
 * cannot be read back out of the URL, because a value the parser refused was never
 * written to it. Deriving the notice from the URL is what made it appear once and then
 * vanish on the next unrelated keystroke, while the box carried on showing a number that
 * filtered nothing.
 *
 * So the notice lasts exactly as long as the mismatch does. It survives a search
 * keystroke, a sort change, a status tick and a back navigation, and it goes when the
 * visitor corrects the value, empties the box, or follows a link that clears the filters.
 */
export interface BoundAdvisory {
  readonly end: BoundEnd
  /** The element the message is rendered in, so the box can describe itself by it. */
  readonly id: string
  readonly text: string
}

export interface BoundBox {
  /** What to show in the input. */
  readonly text: string
  /**
   * Records what was typed, the bound it named, and whether the browser could read the
   * field at all.
   *
   * `badInput` is the one state the text cannot carry. A number input reports its value as
   * the empty string while the field visibly holds `3.`, which is indistinguishable from an
   * emptied box unless the validity is passed along - and without it an applied bound came
   * down with nothing on screen to explain why.
   */
  readonly setText: (typed: string, committed: string, badInput: boolean) => void
  /** This box's message, or null while it is filtering. */
  readonly advisory: BoundAdvisory | null
}

export interface LengthDrafts {
  readonly min: BoundBox
  readonly max: BoundBox
  /** Every box's message, in box order. */
  readonly advisories: readonly BoundAdvisory[]
}

/** Where each box's message is rendered. Fixed, so the input can point at it. */
const ADVISORY_ID: Readonly<Record<BoundEnd, string>> = {
  min: 'length-advisory-min',
  max: 'length-advisory-max',
}

/** What a bound looks like in its box. No bound is an empty box, never a zero. */
export function boundText(value: number | null): string {
  return value === null ? '' : String(value)
}

function useBoundBox(end: BoundEnd, committed: string): BoundBox {
  const draft = useDraft(committed)
  const [unreadable, setUnreadable] = useState(false)
  const record = draft.setText

  const setText = useCallback(
    (typed: string, next: string, badInput: boolean) => {
      record(typed, next)
      setUnreadable(badInput)
    },
    [record],
  )

  const advisory = useMemo<BoundAdvisory | null>(() => {
    const trimmed = draft.text.trim()
    /*
     * An empty text is the only place the validity is consulted, which is what keeps it
     * from outliving the field it described: any committed value the box follows later -
     * from a back navigation, a reset link - fills the text and settles the question on
     * its own.
     */
    const message =
      trimmed === ''
        ? unreadable
          ? boundNotApplied(end, null)
          : null
        : readLengthBound(trimmed) === null
          ? boundNotApplied(end, trimmed)
          : null
    return message === null ? null : { end, id: ADVISORY_ID[end], text: message }
  }, [end, draft.text, unreadable])

  return { text: draft.text, setText, advisory }
}

export function useLengthDrafts(length: LengthRange): LengthDrafts {
  const min = useBoundBox('min', boundText(length.min))
  const max = useBoundBox('max', boundText(length.max))

  const advisories = useMemo(
    () => [min.advisory, max.advisory].filter((one): one is BoundAdvisory => one !== null),
    [min.advisory, max.advisory],
  )

  return { min, max, advisories }
}
