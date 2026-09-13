import { useState, type SubmitEventHandler, type ReactNode } from 'react'
import { SUGGESTIONS_MAX, THEME_MAX_CHARS } from '../suggest/contract'
import {
  preferenceLabel,
  readTheme,
  vibeById,
  VIBES,
  type Preference,
  type ThemeProblem,
} from '../suggest/vibes'
import type { SuggestStore } from '../state/useSuggest'
import { SuggestModelState } from './SuggestModelState'
import { SuggestionItem } from './SuggestionItem'
import type { VerifyBinding } from './verification'

/**
 * The recommender.
 *
 * It sits below the list, not above it, and that is the same budget decision
 * `the first screen is the answer, not an introduction` makes everywhere else: a visitor
 * who came to read names gets names, and anything explaining a feature they have not asked
 * for is charged against a row. It is also what keeps the promise that the base product
 * does not depend on the model - the panel can be in any of its states, including none of
 * them, and the page above it is unaffected.
 *
 * Every name here came out of the snapshot the page is already showing, narrowed by the
 * visitor's own filters. Nothing invents a name, and the model - when there is one - is
 * only asked to order a list it was handed. Explanations are fixed text derived from the
 * deterministic shortlist evidence, and `suggest/parse.ts` accepts no generated prose.
 *
 * A suggestion is a reading recommendation and never a statement about availability. The
 * tick boxes and the links are the same ones the table uses, through the same gate, so a
 * suggested name reaches the ENS app only once a fresh check has covered it.
 */
export interface SuggestPanelProps {
  readonly store: SuggestStore
  /** Null when the deployment has no verifier, which is fixture mode. */
  readonly verify: VerifyBinding | null
  readonly checking: boolean
  readonly onCheck: () => void
  readonly now: Date
}

/** Which of the two inputs the visitor is using. */
type Mode = 'vibe' | 'theme'

/*
 * Why a typed theme was not usable.
 *
 * A total map rather than a switch with a default, so a problem added to `ThemeProblem` is
 * a type error here instead of quietly becoming the vaguest sentence. Each names the
 * requirement rather than describing the text, for the reason `boundNotApplied` gives: a
 * visitor who has just typed something needs to know what would work, not that what they
 * typed did not.
 */
const THEME_PROBLEM: Readonly<Record<ThemeProblem, string>> = {
  empty: 'Type a few words first, or choose one of the vibes above.',
  'too-long': `Use ${String(THEME_MAX_CHARS)} characters or fewer.`,
  'no-terms': 'Use letters or numbers, so there are some words to match against.',
}

const THEME_FIELD_ID = 'suggest-theme'
const THEME_PROBLEM_ID = 'suggest-theme-problem'

/**
 * The chosen vibe as a preference, or null when the id names none.
 *
 * The lookup goes through `vibeById` rather than trusting the state, so the id held here
 * cannot become the only definition of which vibes exist.
 */
function chosenVibe(id: string): Preference | null {
  const vibe = vibeById(id)
  return vibe === null ? null : { kind: 'vibe', vibe }
}

export function SuggestPanel({
  store,
  verify,
  checking,
  onCheck,
  now,
}: SuggestPanelProps): ReactNode {
  /*
   * The chooser's own state, as three fields rather than one.
   *
   * A single value holding either a vibe id or a sentinel meaning 'the theme box' would
   * put the sentinel in the same space as the ids, and a vibe added later could collide
   * with it. Keeping the mode separate makes that impossible rather than unlikely.
   */
  const [mode, setMode] = useState<Mode>('vibe')
  const [vibeId, setVibeId] = useState<string>(VIBES[0]?.id ?? '')
  const [themeText, setThemeText] = useState('')
  /** Set by the first submit. Until then an empty box is untouched rather than wrong. */
  const [attempted, setAttempted] = useState(false)

  const reading = readTheme(themeText)
  /*
   * Reported from the box, live, exactly as a rejected length bound is: the box is what
   * holds the value, so it is what can still see the mismatch after a render that had
   * nothing to do with it. The empty case is held back until a submit, because a box
   * nobody has typed in yet is not a mistake.
   */
  const problem =
    mode === 'theme' && reading.problem !== null && (reading.problem !== 'empty' || attempted)
      ? reading.problem
      : null

  /*
   * A real form, so Enter in the theme field asks for suggestions the way a visitor
   * expects, and so the radio group and the field are one control the keyboard walks
   * through in order.
   */
  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault()
    setAttempted(true)
    const preference: Preference | null = mode === 'vibe' ? chosenVibe(vibeId) : reading.preference
    if (preference === null) {
      return
    }
    store.suggest(preference)
  }

  const answer = store.answer

  return (
    <section aria-labelledby="suggest-title" className="card suggest" id="suggest">
      <div className="section-head suggest__head">
        <h2 className="card__title" id="suggest-title">
          Find a name you would actually use
        </h2>
        <p className="prose">
          Pick a direction and this page will put forward up to {String(SUGGESTIONS_MAX)} names from
          the list above, narrowed by whatever filters you have set. Every one of them is a name the
          scan already knows about - nothing here makes one up.
        </p>
      </div>

      <form className="suggest__form" onSubmit={submit}>
        <fieldset className="fieldset suggest__choices">
          <legend className="fieldset__legend">What are you after?</legend>
          <ul className="suggest__vibes">
            {VIBES.map((vibe) => (
              <li className="suggest__vibe" key={vibe.id}>
                <label className="suggest__option">
                  <input
                    checked={mode === 'vibe' && vibeId === vibe.id}
                    name="suggest-direction"
                    onChange={() => {
                      setMode('vibe')
                      setVibeId(vibe.id)
                    }}
                    type="radio"
                    value={vibe.id}
                  />
                  <span className="suggest__option-label">{vibe.label}</span>
                  <span className="suggest__option-note">{vibe.description}</span>
                </label>
              </li>
            ))}
            <li className="suggest__vibe suggest__vibe--own">
              <label className="suggest__option">
                <input
                  checked={mode === 'theme'}
                  name="suggest-direction"
                  onChange={() => {
                    setMode('theme')
                  }}
                  type="radio"
                />
                <span className="suggest__option-label">Something of my own</span>
                <span className="suggest__option-note">
                  A few words, {String(THEME_MAX_CHARS)} characters at most.
                </span>
              </label>
              <label className="suggest__theme" htmlFor={THEME_FIELD_ID}>
                <span className="visually-hidden">Your own words</span>
                <input
                  aria-describedby={problem === null ? undefined : THEME_PROBLEM_ID}
                  aria-invalid={problem === null ? undefined : true}
                  autoComplete="off"
                  className="input suggest__theme-field"
                  id={THEME_FIELD_ID}
                  onChange={(event) => {
                    setThemeText(event.target.value)
                    setMode('theme')
                  }}
                  placeholder="quiet, coastal, four letters"
                  type="text"
                  value={themeText}
                />
              </label>
            </li>
          </ul>
        </fieldset>

        {/*
          Mounted from the first paint and collapsed while it holds nothing, for the reason
          the page's own advisories block is: a live region that enters the DOM together
          with its first line is announced by nothing, and one line is usually all there is.
        */}
        <div aria-live="polite" className="suggest__advisories">
          {problem !== null && (
            <p className="suggest__advisory" id={THEME_PROBLEM_ID}>
              {THEME_PROBLEM[problem]}
            </p>
          )}
        </div>

        <p className="suggest__submit">
          <button className="button" type="submit">
            Suggest names
          </button>
          {answer !== null && (
            <button className="button button--quiet" onClick={store.clear} type="button">
              Clear suggestions
            </button>
          )}
        </p>
      </form>

      <SuggestModelState store={store} />

      {answer !== null && (
        <div className="suggest__answer">
          {/*
            The request is repeated back, because the chooser above is still sitting on
            whatever the visitor has since clicked. Without it, changing the radio and not
            submitting leaves an answer to the previous request under a control describing a
            different one, and nothing on screen says which of the two these names came from.

            `preferenceLabel` rather than `preferenceDescription`, deliberately: this is the
            one place a typed theme should read back exactly as it was typed. The prompt gets
            the other one, and `suggest/vibes.ts` says why the two exist.
          */}
          <h3 className="suggest__answer-title">
            {answer.suggestions.length === 0
              ? `Nothing in the current list for ${preferenceLabel(answer.preference)}`
              : `${String(answer.suggestions.length)} to consider for ${preferenceLabel(answer.preference)}`}
          </h3>

          {/*
            Which recommender wrote what is on screen. Two different kinds of claim, so
            they are two different sentences and never one hedged one.
          */}
          <p className="suggest__source">
            {answer.source === 'model'
              ? `Ordered by the model running in this browser and described by this page, from ${String(answer.consideredCount)} names your filters allow. It only ever sees that list.`
              : `Ordered by this page from ${String(answer.consideredCount)} names your filters allow, by how closely each one matches what you asked for. The same request gives the same order every time.`}
          </p>

          {answer.suggestions.length === 0 ? (
            <p className="suggest__empty">
              None of the names in the current view are a close enough match. Widening the filters,
              or clearing the search, gives it more to work with.
            </p>
          ) : (
            <>
              <ul className="suggest__list">
                {answer.suggestions.map((suggestion) => (
                  <SuggestionItem
                    key={suggestion.name}
                    now={now}
                    suggestion={suggestion}
                    verify={verify}
                  />
                ))}
              </ul>

              {verify === null ? (
                <p className="suggest__note">
                  This build has no verifier, so none of these can be re-checked and none of them
                  offers a link to a registration page.
                </p>
              ) : (
                <div className="suggest__actions">
                  <button
                    className="button"
                    disabled={checking || verify.selected.size === 0}
                    onClick={onCheck}
                    type="button"
                  >
                    {checking ? 'Checking' : 'Check the ticked names now'}
                  </button>
                  <p className="suggest__note">
                    A suggestion is a reading of the list, not a statement about availability. Tick
                    the ones you like and check them: a name links out to the ENS app only while a
                    fresh check covers it, and ENS is the final authority on whether it can be
                    registered.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
