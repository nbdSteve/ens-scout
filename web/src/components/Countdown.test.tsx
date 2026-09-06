import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Boundary } from '../snapshot/lifecycle'
import { instant } from '../test/dom'
import { Countdown } from './Countdown'

/**
 * The countdown is presentation of one published instant, so these tests fix both
 * the instant and the clock. Nothing here asserts a status: a countdown reaching
 * zero must not change what the scan recorded, and the tests below say so by
 * checking that the passed case adds a warning rather than a new state.
 */

const NOW = new Date('2026-03-01T12:00:00Z')

function boundary(at: string, kind: Boundary['kind'] = 'expiry'): Boundary {
  const label =
    kind === 'expiry'
      ? 'registration expires'
      : kind === 'grace-end'
        ? 'grace period ends'
        : 'premium ends'
  return { kind, at: new Date(at), label }
}

describe('Countdown ahead of the clock', () => {
  it('shows the exact instant, a machine-readable copy of it, and the time left', () => {
    render(<Countdown boundary={boundary('2026-03-04T15:04:05Z')} now={NOW} />)

    const stamp = screen.getByText(instant('2026-03-04 15:04:05 UTC'))
    expect(stamp.tagName).toBe('TIME')
    expect(stamp).toHaveAttribute('datetime', '2026-03-04T15:04:05Z')
    expect(screen.getByText('3d 03:04:05')).toBeInTheDocument()
  })

  it('hides the ticking value and announces one coarse sentence instead', () => {
    render(<Countdown boundary={boundary('2026-03-04T15:04:05Z')} now={NOW} />)

    // A value that changes every second must not be announced every second, and
    // fifty rows of them would make the table unusable.
    expect(screen.getByText('3d 03:04:05')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('registration expires in 3 days 3 hours')).toBeInTheDocument()
  })

  it('names the boundary the snapshot recorded, without inferring another', () => {
    render(<Countdown boundary={boundary('2026-03-02T12:00:00Z', 'grace-end')} now={NOW} />)

    expect(screen.getByText('grace period ends')).toBeInTheDocument()
    expect(screen.getByText('grace period ends in 1 day')).toBeInTheDocument()
    expect(screen.queryByText(/has passed since the scan/)).not.toBeInTheDocument()
  })
})

describe('Countdown once the instant has passed', () => {
  it('states it in the past tense and says the recorded status still stands', () => {
    render(<Countdown boundary={boundary('2026-03-01T10:00:00Z')} now={NOW} />)

    expect(screen.getByText('registration expired')).toBeInTheDocument()
    expect(screen.getByText('registration expired 2 hours ago')).toBeInTheDocument()
    expect(screen.getByText(/The status is still the one the scan recorded/)).toBeInTheDocument()
  })

  it('shows the elapsed time rather than a row of zeroes', () => {
    render(<Countdown boundary={boundary('2026-02-28T12:00:00Z', 'premium-end')} now={NOW} />)

    expect(screen.getByText('1d 00:00:00')).toBeInTheDocument()
    expect(screen.getByText('premium ended 1 day ago')).toBeInTheDocument()
  })

  it('treats the exact instant as passed, so nothing reads as still ahead', () => {
    render(<Countdown boundary={boundary('2026-03-01T12:00:00Z')} now={NOW} />)

    expect(screen.getByText('registration expired')).toBeInTheDocument()
    expect(screen.getByText('registration expired just now')).toBeInTheDocument()
  })
})
