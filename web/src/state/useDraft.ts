import { useCallback, useState } from 'react'

/**
 * A text input whose committed value is canonicalized somewhere else.
 *
 * The URL holds the canonical value: a search term is lowercased and stripped of
 * its `.eth` suffix, and a length bound is either an integer in range or absent.
 * Binding an input straight to that would fight the visitor - typing `A` would
 * turn into `a` under the caret, and clearing a bound to retype it would blank the
 * box. So what was typed is kept alongside the canonical value it produced, and
 * the typed text is shown for as long as the two still agree.
 *
 * When the canonical value changes from somewhere else - the back button, a reset
 * link, a shared link - it no longer matches, and the input follows it. That is
 * decided during render rather than in an effect, so there is no frame in which
 * the box shows a value the URL has already left behind.
 */
export interface Draft {
  /** What to show in the input. */
  readonly text: string
  /** Records what was typed and the canonical value it was committed as. */
  readonly setText: (typed: string, committed: string) => void
}

export function useDraft(committed: string): Draft {
  const [draft, setDraft] = useState({ typed: committed, from: committed })
  const text = draft.from === committed ? draft.typed : committed

  const setText = useCallback((typed: string, next: string) => {
    setDraft({ typed, from: next })
  }, [])

  return { text, setText }
}
