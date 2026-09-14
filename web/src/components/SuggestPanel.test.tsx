import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { SUGGESTIONS_MAX, THEME_MAX_CHARS } from '../suggest/contract'
import type { Suggestion } from '../suggest/shortlist'
import { VIBES, type Preference } from '../suggest/vibes'
import type { SuggestAnswer, SuggestStore } from '../state/useSuggest'
import type { VerifiedName } from '../verify/types'
import { SuggestPanel } from './SuggestPanel'
import type { VerifyBinding } from './verification'

/**
 * The chooser, and the answer under it.
 *
 * Three things are worth more here than the layout. A visitor asks for a direction and the
 * panel passes exactly that direction on, unrepaired: a theme that names no terms is
 * reported rather than silently ranked as something else. The answer repeats the request
 * back, because the chooser above it is still sitting on whatever has been clicked since,
 * and without that the names on screen would be attributed to a request nobody made. And
 * the answer separates model ordering from the repository-owned explanations.
 *
 * The panel is also where the promise that the base product does not need the model is
 * visible: every one of these tests renders a store that never loaded one.
 */

const NOW = new Date('2026-03-01T12:00:00Z')

const NATURE = VIBES.find((vibe) => vibe.id === 'nature')
const FIRST = VIBES[0]

function requireVibe(vibe: (typeof VIBES)[number] | undefined): (typeof VIBES)[number] {
  if (vibe === undefined) {
    throw new Error('the built-in vibes are a closed list and this test needs one of them')
  }
  return vibe
}

function suggestion(label: string, reason: string): Suggestion {
  return { name: `${label}.eth`, label, reason }
}

function answer(overrides: Partial<SuggestAnswer> = {}): SuggestAnswer {
  return {
    preference: { kind: 'vibe', vibe: requireVibe(NATURE) },
    suggestions: [
      suggestion('moss', 'Damp stone, and four letters.'),
      suggestion('fern', 'Quiet, and easy to say.'),
    ],
    source: 'deterministic',
    consideredCount: 17,
    ...overrides,
  }
}

function binding(overrides: Partial<VerifyBinding> = {}): VerifyBinding {
  return {
    selected: new Set<string>(),
    full: false,
    pending: new Set<string>(),
    verified: new Map<string, VerifiedName>(),
    onToggle: () => undefined,
    ...overrides,
  }
}

interface Harness {
  readonly suggest: Mock<(preference: Preference) => void>
  readonly clear: Mock<() => void>
  readonly onCheck: Mock<() => void>
}

interface Options {
  readonly answer?: SuggestAnswer | null
  readonly verify?: VerifyBinding | null
  readonly checking?: boolean
}

function mount(options: Options = {}): Harness {
  const harness: Harness = {
    suggest: vi.fn<(preference: Preference) => void>(),
    clear: vi.fn<() => void>(),
    onCheck: vi.fn<() => void>(),
  }
  const store: SuggestStore = {
    /*
     * Turned off, deliberately, in every one of these tests. The chooser and the answer
     * are the same in every model state, and that is the promise being kept.
     */
    phase: 'disabled',
    progress: null,
    slow: false,
    failure: null,
    cached: false,
    answer: options.answer ?? null,
    capabilities: { pause: false, resume: false, disable: false, enable: true },
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    disable: vi.fn<() => void>(),
    enable: vi.fn<() => void>(),
    suggest: harness.suggest,
    clear: harness.clear,
  }
  render(
    <SuggestPanel
      checking={options.checking ?? false}
      now={NOW}
      onCheck={harness.onCheck}
      store={store}
      verify={options.verify === undefined ? binding() : options.verify}
    />,
  )
  return harness
}

/** The theme box, by the label its own hidden span gives it. */
function themeField(): HTMLElement {
  return screen.getByLabelText('Your own words')
}

describe('what the panel offers', () => {
  it('is a titled section that states the bound and that nothing is invented', () => {
    mount()

    expect(
      screen.getByRole('heading', { name: 'Find a name you would actually use' }),
    ).toBeVisible()
    expect(
      screen.getByText(new RegExp(`up to ${String(SUGGESTIONS_MAX)} names from`)),
    ).toBeInTheDocument()
    expect(screen.getByText(/nothing here makes one up/)).toBeInTheDocument()
  })

  /*
   * One radio per built-in vibe and one more for the box, in one group, so the keyboard
   * walks the whole choice as a single control and a screen reader is told how many
   * options there are.
   */
  it('offers every built-in vibe and a box of one’s own, as one group', () => {
    mount()

    const group = screen.getByRole('group', { name: 'What are you after?' })
    expect(within(group).getAllByRole('radio')).toHaveLength(VIBES.length + 1)
    for (const vibe of VIBES) {
      expect(within(group).getByRole('radio', { name: new RegExp(vibe.label) })).toBeInTheDocument()
    }
    expect(within(group).getByRole('radio', { name: /Something of my own/ })).toBeInTheDocument()
  })

  it('says what each vibe favours, so the choice is not made from its name alone', () => {
    mount()

    for (const vibe of VIBES) {
      expect(screen.getByText(vibe.description)).toBeInTheDocument()
    }
  })

  it('states the theme bound beside the box rather than only enforcing it', () => {
    mount()

    expect(
      screen.getByText(new RegExp(`${String(THEME_MAX_CHARS)} characters at most`)),
    ).toBeInTheDocument()
  })

  /* A choice already made, so a visitor who wants a suggestion can just ask for one. */
  it('starts on the first vibe', () => {
    mount()

    expect(screen.getByRole('radio', { name: new RegExp(requireVibe(FIRST).label) })).toBeChecked()
  })
})

describe('asking for names', () => {
  it('passes the chosen vibe on exactly as it is defined', async () => {
    const harness = mount()
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: new RegExp(requireVibe(NATURE).label) }))
    await user.click(screen.getByRole('button', { name: 'Suggest names' }))

    expect(harness.suggest).toHaveBeenCalledWith({ kind: 'vibe', vibe: requireVibe(NATURE) })
  })

  /*
   * The theme reaches the recommenders as terms. The text is kept too, but only for
   * reading back: `suggest/vibes.ts` says why the two are separate.
   */
  it('reads a typed theme into terms', async () => {
    const harness = mount()
    const user = userEvent.setup()

    await user.type(themeField(), 'quiet coastal')
    await user.click(screen.getByRole('button', { name: 'Suggest names' }))

    expect(harness.suggest).toHaveBeenCalledWith({
      kind: 'theme',
      theme: 'quiet coastal',
      terms: ['quiet', 'coastal'],
    })
  })

  /* Typing in the box is choosing it, so nobody has to click the radio as well. */
  it('switches to the box when a visitor types in it', async () => {
    mount()

    await userEvent.setup().type(themeField(), 'quiet')

    expect(screen.getByRole('radio', { name: /Something of my own/ })).toBeChecked()
  })

  /*
   * A real form, so Enter in the box asks for suggestions the way a visitor expects rather
   * than doing nothing.
   */
  it('asks for suggestions when Enter is pressed in the box', async () => {
    const harness = mount()

    await userEvent.setup().type(themeField(), 'quiet coastal{Enter}')

    expect(harness.suggest).toHaveBeenCalledTimes(1)
  })

  /*
   * Choosing a vibe after typing means the vibe. The mode is separate state rather than a
   * sentinel among the ids, so this cannot depend on what the box still holds.
   */
  it('means the vibe when a vibe is chosen after something was typed', async () => {
    const harness = mount()
    const user = userEvent.setup()

    await user.type(themeField(), 'quiet coastal')
    await user.click(screen.getByRole('radio', { name: new RegExp(requireVibe(NATURE).label) }))
    await user.click(screen.getByRole('button', { name: 'Suggest names' }))

    expect(harness.suggest).toHaveBeenCalledWith({ kind: 'vibe', vibe: requireVibe(NATURE) })
  })
})

describe('a theme that cannot be used', () => {
  /*
   * A box nobody has typed in yet is not a mistake, so the empty case is held back until a
   * submit asks something of it. Every other problem is reported live, from the box, for
   * the reason a rejected length bound is: the box is what still holds the value.
   */
  it('says nothing about an empty box until something is asked of it', async () => {
    const harness = mount()
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: /Something of my own/ }))
    expect(screen.queryByText(/Type a few words first/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Suggest names' }))

    expect(
      screen.getByText('Type a few words first, or choose one of the vibes above.'),
    ).toBeVisible()
    expect(harness.suggest).not.toHaveBeenCalled()
  })

  it('says what would work when the text is too long', async () => {
    const harness = mount()

    await userEvent.setup().type(themeField(), 'a'.repeat(THEME_MAX_CHARS + 1))

    expect(
      screen.getByText(`Use ${String(THEME_MAX_CHARS)} characters or fewer.`),
    ).toBeInTheDocument()
    expect(harness.suggest).not.toHaveBeenCalled()
  })

  it('says what would work when the text holds no words at all', async () => {
    mount()

    await userEvent.setup().type(themeField(), '!!! ---')

    expect(
      screen.getByText('Use letters or numbers, so there are some words to match against.'),
    ).toBeInTheDocument()
  })

  /*
   * The box points at the line, so the requirement is read out with the field rather than
   * only sitting near it, and the field reports itself invalid while the mismatch lasts.
   */
  it('describes the box with the line, and marks the box invalid', async () => {
    mount()

    await userEvent.setup().type(themeField(), '!!!')

    expect(themeField()).toHaveAccessibleDescription(
      'Use letters or numbers, so there are some words to match against.',
    )
    expect(themeField()).toHaveAttribute('aria-invalid', 'true')
  })

  /*
   * The notice lasts exactly as long as the mismatch. It is derived from the box on every
   * render rather than captured, so correcting the text clears it and nothing else does.
   */
  it('clears the line and the invalid flag once the text would work', async () => {
    const harness = mount()
    const user = userEvent.setup()

    await user.type(themeField(), '!!!')
    await user.clear(themeField())
    await user.type(themeField(), 'quiet coastal')

    expect(screen.queryByText(/Use letters or numbers/)).toBeNull()
    expect(themeField()).not.toHaveAttribute('aria-invalid')

    await user.click(screen.getByRole('button', { name: 'Suggest names' }))
    expect(harness.suggest).toHaveBeenCalledTimes(1)
  })

  /*
   * A live region has to be in the document before the mutation it should announce. One
   * rendered together with its first line is announced by nothing, and one line is usually
   * all there is here.
   */
  it('holds the polite region open before there is anything to announce', async () => {
    mount()

    const region = document.querySelector('.suggest__advisories')
    expect(region).not.toBeNull()
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region?.textContent).toBe('')

    await userEvent.setup().type(themeField(), '!!!')

    expect(region).toContainElement(screen.getByText(/Use letters or numbers/))
  })
})

describe('the answer', () => {
  /*
   * The request is repeated back, because the chooser above is still sitting on whatever
   * has been clicked since. `preferenceLabel` rather than `preferenceDescription`: this is
   * the one place a theme reads back exactly as it was typed.
   */
  it('repeats the request back with the count it produced', () => {
    mount({ answer: answer() })

    expect(
      screen.getByRole('heading', { name: `2 to consider for ${requireVibe(NATURE).label}` }),
    ).toBeVisible()
  })

  it('reads a theme back in the visitor’s own words', () => {
    mount({
      answer: answer({
        preference: { kind: 'theme', theme: 'quiet, coastal', terms: ['quiet', 'coastal'] },
      }),
    })

    expect(screen.getByRole('heading', { name: '2 to consider for quiet, coastal' })).toBeVisible()
  })

  it('lists every suggestion with its own sentence', () => {
    mount({ answer: answer() })

    /* The vibes are a list too, so this one is addressed by its own class. */
    const list = document.querySelector('.suggest__list')
    expect(list).not.toBeNull()
    expect(within(list as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Damp stone, and four letters.')).toBeInTheDocument()
    expect(screen.getByText('Quiet, and easy to say.')).toBeInTheDocument()
  })

  /*
   * Which recommender wrote what is on screen, as two different sentences rather than one
   * hedged one, and both say the shortlist the names came out of was bounded by the
   * visitor's own filters.
   */
  it('says this page wrote the sentences, and that the same request repeats', () => {
    mount({ answer: answer({ source: 'deterministic' }) })

    expect(screen.getByText(/Ordered by this page from 17 names your filters allow/)).toBeVisible()
    expect(screen.getByText(/same request gives the same order every time/)).toBeInTheDocument()
  })

  it('says the model ordered them, this page described them, and what it saw', () => {
    mount({ answer: answer({ source: 'model' }) })

    expect(
      screen.getByText(
        /Ordered by the model running in this browser and described by this page, from 17 names/,
      ),
    ).toBeVisible()
    expect(screen.getByText(/only ever sees that list/)).toBeInTheDocument()
  })

  /*
   * An answer with nothing in it is a real answer about the current filters, not a failure,
   * so it says what would give the recommender more to work with.
   */
  it('says the current list holds nothing for the request, and what would help', () => {
    mount({ answer: answer({ suggestions: [] }) })

    expect(
      screen.getByRole('heading', {
        name: `Nothing in the current list for ${requireVibe(NATURE).label}`,
      }),
    ).toBeVisible()
    expect(screen.getByText(/Widening the filters/)).toBeInTheDocument()
  })

  it('offers nothing to clear until there is an answer, and then does', async () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Clear suggestions' })).toBeNull()

    const harness = mount({ answer: answer() })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear suggestions' }))
    expect(harness.clear).toHaveBeenCalledTimes(1)
  })
})

describe('checking what was suggested', () => {
  /*
   * The same bounded fresh check the name field uses, because a suggested name earns an outbound
   * link on the same evidence a scanned one does and on no less.
   */
  it('offers the check, and says ENS decides', async () => {
    const harness = mount({
      answer: answer(),
      verify: binding({ selected: new Set(['moss.eth']) }),
    })

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Check the ticked names now' }))

    expect(harness.onCheck).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/not a statement about availability/)).toBeInTheDocument()
    expect(screen.getByText(/ENS is the final authority/)).toBeInTheDocument()
  })

  it('disables the check until a suggestion is selected', () => {
    mount({ answer: answer() })

    expect(screen.getByRole('button', { name: 'Check the ticked names now' })).toBeDisabled()
  })

  it('refuses a second request while one is running, and says which state it is in', () => {
    mount({ answer: answer(), checking: true })

    expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled()
  })

  /*
   * Fixture mode. There is no verifier, so nothing could judge a link and nothing offers
   * one - and the panel says that rather than leaving a visitor to notice.
   */
  it('says why there are no links at all when the deployment has no verifier', () => {
    mount({ answer: answer(), verify: null })

    expect(screen.getByText(/This build has no verifier/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Check the ticked names/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  /* Nothing to check, so no action - the empty answer is not an invitation. */
  it('offers no check when the answer named nothing', () => {
    mount({ answer: answer({ suggestions: [] }) })

    expect(screen.queryByRole('button', { name: /Check the ticked names/ })).toBeNull()
  })
})

describe('the model panel below it', () => {
  /*
   * The chooser and the answer do not depend on the model, and the model state is a block
   * inside the same panel rather than a gate in front of it.
   */
  it('is present, and the chooser works, with the model turned off', () => {
    mount({ answer: answer() })

    expect(screen.getByRole('status')).toHaveTextContent(/turned off on this device/)
    expect(screen.getByRole('button', { name: 'Suggest names' })).toBeEnabled()
    expect(screen.getByRole('heading', { level: 3 })).toBeVisible()
  })
})
