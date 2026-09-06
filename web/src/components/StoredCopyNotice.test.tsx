import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LoadFailure } from '../state/useSnapshot'
import { StoredCopyNotice } from './StoredCopyNotice'

/**
 * What the band says happened, and whether what it offers can work.
 *
 * Three failures put an earlier scan on screen and only one of them is an unreachable API.
 * Saying so for the other two would be the page claiming something it had not established,
 * which is the one thing it must never do - and offering another request for a payload this
 * build refuses by version is a button that cannot succeed.
 */

function failure(kind: LoadFailure['kind']): LoadFailure {
  return { kind, message: 'a reported reason' }
}

describe('StoredCopyNotice', () => {
  it.each([
    ['unavailable', 'The read API could not be reached'],
    ['malformed', 'The read API answered with a snapshot this page could not read'],
    ['version', 'The read API answered in a format newer than this page understands'],
  ] as const)('says what actually happened for a %s failure', (kind, said) => {
    render(<StoredCopyNotice failure={failure(kind)} onRetry={vi.fn()} />)

    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent(said)
    expect(notice).toHaveTextContent('this is the snapshot this browser stored on an earlier visit')
    expect(notice).toHaveTextContent('a reported reason')
  })

  it('reloads the document for a version mismatch, because another request cannot fix one', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onReload = vi.fn()
    render(<StoredCopyNotice failure={failure('version')} onReload={onReload} onRetry={onRetry} />)

    await user.click(screen.getByRole('button', { name: 'Reload the page' }))

    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'malformed'] as const)(
    're-reads the snapshot for a %s failure, which another request can fix',
    async (kind) => {
      const user = userEvent.setup()
      const onRetry = vi.fn()
      const onReload = vi.fn()
      render(<StoredCopyNotice failure={failure(kind)} onReload={onReload} onRetry={onRetry} />)

      await user.click(screen.getByRole('button', { name: 'Try to refresh' }))

      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onReload).not.toHaveBeenCalled()
    },
  )
})
