import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { CHECK_MAX_NAMES } from '../verify/contract'
import { describeCheckFailure } from '../verify/failure'
import { CheckError } from '../verify/check'
import { CheckVersionError } from '../verify/parse'
import { VerifyBar } from './VerifyBar'

/**
 * The action, and what it says when it fails.
 *
 * The failure cases are the ones worth the most here: a check that produced no answer
 * must not leave the page implying it produced one, and the two recoveries it offers
 * have to match what could actually clear the failure.
 */

/*
 * The mocks carry the prop's own signature rather than `ReturnType<typeof vi.fn>`, which
 * widens to a callable-or-constructable and then no longer satisfies `() => void`.
 */
interface Handlers {
  readonly onCheck: Mock<() => void>
  readonly onClear: Mock<() => void>
  readonly onDismiss: Mock<() => void>
}

function mount(
  overrides: {
    selected?: readonly string[]
    checking?: boolean
    failure?: Parameters<typeof VerifyBar>[0]['failure']
  } = {},
): Handlers {
  const handlers: Handlers = {
    onCheck: vi.fn<() => void>(),
    onClear: vi.fn<() => void>(),
    onDismiss: vi.fn<() => void>(),
  }
  render(
    <VerifyBar
      checking={overrides.checking ?? false}
      failure={overrides.failure ?? null}
      onCheck={handlers.onCheck}
      onClear={handlers.onClear}
      onDismiss={handlers.onDismiss}
      selected={new Set(overrides.selected ?? [])}
    />,
  )
  return handlers
}

/*
 * The failures are built from thrown values through `describeCheckFailure`, not written
 * by hand. A hand-written `{ retryable: true }` would let the recovery tests pass while
 * the real classification disagreed with them.
 */
const THROTTLED = describeCheckFailure(new CheckError('refused', 429, 'client_throttled'))
const REFUSED = describeCheckFailure(new CheckError('refused', 400, 'malformed_request'))
const NEWER = describeCheckFailure(new CheckVersionError(2))

describe('VerifyBar presence', () => {
  /*
   * `the first screen is the answer, not an introduction` charges anything above the
   * list against a name row, so a bar explaining a feature nobody has used yet is a row
   * spent on every visit.
   */
  it('renders nothing before a visitor has selected anything', () => {
    mount()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('appears once a name is selected', () => {
    mount({ selected: ['aaaa.eth'] })
    expect(screen.getByRole('button', { name: 'Check these now' })).toBeInTheDocument()
  })

  /*
   * A failure has to outlive the selection that produced it. Otherwise a visitor who
   * cleared their selection after a failed check would be shown nothing about it.
   */
  it('stays on screen for a failure after the selection is empty', () => {
    mount({ failure: THROTTLED })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Nothing selected')).toBeInTheDocument()
  })
})

describe('VerifyBar count', () => {
  it('states the count against the bound it will refuse at', () => {
    mount({ selected: ['aaaa.eth', 'bbbb.eth'] })
    expect(screen.getByText(`2 of ${String(CHECK_MAX_NAMES)} names selected`)).toBeInTheDocument()
  })

  /*
   * A status region, so a tick announces the new count without taking focus off the
   * checkbox the visitor is working through the list with.
   */
  it('announces the count without moving focus', () => {
    mount({ selected: ['aaaa.eth'] })
    expect(screen.getByRole('status')).toHaveTextContent(
      `1 of ${String(CHECK_MAX_NAMES)} names selected`,
    )
  })
})

describe('VerifyBar actions', () => {
  it('asks for a check and reports it running', async () => {
    const handlers = mount({ selected: ['aaaa.eth'] })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Check these now' }))
    expect(handlers.onCheck).toHaveBeenCalledTimes(1)
  })

  it('refuses a second request while one is running, and says which state it is in', () => {
    mount({ selected: ['aaaa.eth'], checking: true })

    expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled()
  })

  it('clears the selection on request', async () => {
    const handlers = mount({ selected: ['aaaa.eth'] })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(handlers.onClear).toHaveBeenCalledTimes(1)
  })

  it('offers nothing to clear when nothing is selected', () => {
    mount({ failure: THROTTLED })
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull()
  })

  /*
   * ENS is named on the action as well as on the link, because the visitor decides to
   * check here and a check is the thing most easily mistaken for an answer.
   */
  it('states that ENS decides, and that a check reserves nothing', () => {
    mount({ selected: ['aaaa.eth'] })

    expect(
      screen.getByText(
        /not a reservation, and ENS is the final authority on whether a name can be registered/,
      ),
    ).toBeInTheDocument()
  })
})

describe('VerifyBar failure', () => {
  /*
   * The two things a visitor most needs to know after a failed check, and the two
   * things the page would otherwise be implying the opposite of.
   */
  it('says the selection survived and that no status was replaced by a guess', () => {
    mount({ selected: ['aaaa.eth'], failure: THROTTLED })

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(THROTTLED.message)).toBeInTheDocument()
    expect(within(alert).getByText(/Your selection is unchanged/)).toBeInTheDocument()
    expect(within(alert).getByText(/still what the scan recorded/)).toBeInTheDocument()
  })

  it('interrupts, because it appeared after the rows below it were rendered', () => {
    mount({ selected: ['aaaa.eth'], failure: THROTTLED })
    expect(screen.getByRole('alert')).toHaveTextContent('Fresh check failed')
  })

  it('offers another attempt for a failure another attempt could clear', async () => {
    const handlers = mount({ selected: ['aaaa.eth'], failure: THROTTLED })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(handlers.onCheck).toHaveBeenCalledTimes(1)
  })

  /*
   * A button that cannot succeed is worse than no button. The page built the bad
   * request, so the same request will be refused again.
   */
  it('offers no retry for a failure no retry can clear', () => {
    mount({ selected: ['aaaa.eth'], failure: REFUSED })

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  /*
   * The answer is newer than this bundle, so asking again from this bundle lands on the
   * same refusal. Only a document load can pick up the page that reads it.
   */
  it('offers a reload, and only a reload, for an answer newer than this build', () => {
    mount({ selected: ['aaaa.eth'], failure: NEWER })

    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('lets the visitor put the banner away', async () => {
    const handlers = mount({ selected: ['aaaa.eth'], failure: THROTTLED })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('shows no banner when there is no failure', () => {
    mount({ selected: ['aaaa.eth'] })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
