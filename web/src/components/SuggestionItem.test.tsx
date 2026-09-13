import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Status } from '../snapshot/contract'
import type { Suggestion } from '../suggest/shortlist'
import type { VerifiedName } from '../verify/types'
import { SuggestionItem } from './SuggestionItem'
import type { VerifyBinding } from './verification'

/**
 * One suggested name, and what it takes for it to become a link.
 *
 * The rule is the only interesting thing here, and it is the reason this component was
 * written through `rowVerification` rather than with a check of its own: a suggested name
 * is less verified than a scanned one - it was chosen for how it reads, not for what the
 * index said - so it earns an outbound link on exactly the same evidence a scanned row
 * does, a fresh check that covers it and has not lapsed.
 *
 * The tests therefore drive the gate rather than the component: an unchecked name, a
 * checked one, and one whose check has lapsed. A `verify` of null is fixture mode, where
 * there is no verifier at all and so nothing to judge a link against.
 */

const CHECKED_AT = new Date('2026-03-01T12:00:00Z')
const EXPIRES_AT = new Date('2026-03-01T12:01:00Z')

/** During the check's own window, so a covered name is current. */
const NOW = new Date('2026-03-01T12:00:30Z')

/** After it, so the same check no longer covers anything. */
const LATER = new Date('2026-03-01T12:02:00Z')

const SUGGESTION: Suggestion = {
  name: 'moss.eth',
  label: 'moss',
  reason: 'Damp stone, and four letters.',
}

function verifiedName(name: string, status: Status = 'available'): VerifiedName {
  return {
    result: {
      name,
      label: name.slice(0, -'.eth'.length),
      status,
      expiry: null,
      graceEnds: null,
      premiumEnds: null,
    },
    checkedAt: CHECKED_AT,
    expiresAt: EXPIRES_AT,
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

function mount(
  overrides: {
    suggestion?: Suggestion
    verify?: VerifyBinding | null
    now?: Date
  } = {},
): void {
  render(
    <ul>
      <SuggestionItem
        now={overrides.now ?? NOW}
        suggestion={overrides.suggestion ?? SUGGESTION}
        verify={overrides.verify === undefined ? binding() : overrides.verify}
      />
    </ul>,
  )
}

describe('what a suggestion says', () => {
  it('names the name and carries the sentence beside it', () => {
    mount()

    expect(screen.getByText('moss.eth')).toBeInTheDocument()
    expect(screen.getByText('Damp stone, and four letters.')).toBeInTheDocument()
  })

  /*
   * Whatever repository-owned sentence was derived, it is presented as a reason for the
   * ranking and rendered as text rather than interpreted as markup.
   */
  it('renders the sentence as text, whatever it says', () => {
    mount({
      suggestion: {
        name: 'moss.eth',
        label: 'moss',
        reason: 'Reads well & short <em>even</em> so.',
      },
    })

    expect(screen.getByText('Reads well & short <em>even</em> so.')).toBeInTheDocument()
    expect(screen.queryByText('even')).toBeNull()
  })
})

describe('the outbound link', () => {
  /*
   * The rule. An unchecked name has nothing behind it but a scan this page is presenting
   * as a reading recommendation, so there is nowhere to send the visitor yet.
   */
  it('is absent for a name no fresh check covers, and says so', () => {
    mount()

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('No fresh check')).toBeInTheDocument()
  })

  it('appears once a fresh check covers the name', () => {
    mount({ verify: binding({ verified: new Map([['moss.eth', verifiedName('moss.eth')]]) }) })

    expect(screen.getByRole('link', { name: /moss\.eth/ })).toBeInTheDocument()
    const checkedAt = screen.getByText('12:00:00 UTC')
    expect(checkedAt.parentElement).toHaveTextContent('Fresh check')
    expect(checkedAt).toHaveAttribute('datetime', '2026-03-01T12:00:00Z')
    expect(screen.getByText('Available')).toBeInTheDocument()
  })

  /*
   * Named on the link itself, because that is the moment a visitor leaves. Everything on
   * this page is a record of a read; the authority is at the other end.
   */
  it('says ENS decides, on the link a visitor is about to follow', () => {
    mount({ verify: binding({ verified: new Map([['moss.eth', verifiedName('moss.eth')]]) }) })

    expect(
      screen.getByRole('link', {
        name: /final authority on whether it can be registered/,
      }),
    ).toBeInTheDocument()
  })

  /*
   * The gate judges expiry against the instant the caller renders at, so a check that was
   * good a minute ago closes the link again rather than aging into one nobody re-examines.
   */
  it('closes again once the check has lapsed, and says which of the two it is', () => {
    mount({
      now: LATER,
      verify: binding({ verified: new Map([['moss.eth', verifiedName('moss.eth')]]) }),
    })

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Fresh check has lapsed')).toBeInTheDocument()
    expect(screen.getByText('12:00:00 UTC')).toHaveAttribute('datetime', '2026-03-01T12:00:00Z')
    expect(screen.getByText('Available')).toBeInTheDocument()
  })

  it('shows the latest checked status even when it differs from the scan-era suggestion', () => {
    mount({
      verify: binding({
        verified: new Map([['moss.eth', verifiedName('moss.eth', 'registered')]]),
      }),
    })

    expect(screen.getByText('Registered')).toBeInTheDocument()
    expect(screen.getByText('12:00:00 UTC')).toBeInTheDocument()
  })

  /*
   * A check that covered some other name is not evidence about this one. The map is keyed
   * per name for exactly this reason.
   */
  it('is absent for a name some other check covered', () => {
    mount({ verify: binding({ verified: new Map([['fern.eth', verifiedName('fern.eth')]]) }) })

    expect(screen.queryByRole('link')).toBeNull()
  })

  it('says a check is running while one is in flight', () => {
    mount({ verify: binding({ pending: new Set(['moss.eth']) }) })

    expect(screen.getByText('Fresh check running')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('a deployment with no verifier', () => {
  /*
   * Fixture mode. There is no verifier, so there is nothing that could judge a link, and a
   * tick box that led nowhere would be an invitation with no destination.
   */
  it('offers no tick box, no link, and no note about a check', () => {
    mount({ verify: null })

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(/fresh check/i)).toBeNull()
    expect(screen.getByText('moss.eth')).toBeInTheDocument()
  })
})

describe('picking a suggestion for a check', () => {
  it('offers a tick box named after the name it would check', () => {
    mount()
    expect(screen.getByRole('checkbox', { name: 'Fresh check moss.eth' })).toBeInTheDocument()
  })

  it('reports a tick to the same handler the table uses', async () => {
    const onToggle = vi.fn<(name: string) => void>()
    mount({ verify: binding({ onToggle }) })

    await userEvent.setup().click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith('moss.eth')
  })

  it('shows a ticked box for a name already in the selection', () => {
    mount({ verify: binding({ selected: new Set(['moss.eth']) }) })
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  /*
   * One check covers a bounded number of names, so an unticked box is refused once the
   * selection is full rather than accepted and then dropped by the request.
   */
  it('refuses a new tick once the selection is full', () => {
    mount({ verify: binding({ full: true }) })
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('still lets a name already in a full selection be unticked', () => {
    mount({ verify: binding({ full: true, selected: new Set(['moss.eth']) }) })
    expect(screen.getByRole('checkbox')).toBeEnabled()
  })
})
