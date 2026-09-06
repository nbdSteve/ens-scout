import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LoadFailure } from '../state/useSnapshot'
import { ErrorState } from './ErrorState'

/**
 * The one button on the error page has to do what its label says.
 *
 * This page's whole contract is that it never claims something it has not done, and a
 * button is a claim like any other: two of the three failures are worth another request,
 * and the third is worth a document load and nothing else.
 */

function failure(kind: LoadFailure['kind']): LoadFailure {
  return { kind, message: 'a reported reason' }
}

describe('ErrorState', () => {
  it('reloads the document for a version mismatch, because a retry cannot fix one', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onReload = vi.fn()
    render(<ErrorState failure={failure('version')} onReload={onReload} onRetry={onRetry} />)

    // The label is the promise being kept: the payload is newer than this bundle, so
    // fetching it again from the same bundle would land on the same error.
    await user.click(screen.getByRole('button', { name: 'Reload the page' }))

    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed', 'Try loading it again'],
    ['unavailable', 'Try again'],
  ] as const)('re-reads the snapshot for a %s failure', async (kind, label) => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onReload = vi.fn()
    render(<ErrorState failure={failure(kind)} onReload={onReload} onRetry={onRetry} />)

    await user.click(screen.getByRole('button', { name: label }))

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onReload).not.toHaveBeenCalled()
  })

  it('shows the reported reason, which is what makes a failure reportable', () => {
    render(<ErrorState failure={failure('unavailable')} onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('a reported reason')
  })
})
