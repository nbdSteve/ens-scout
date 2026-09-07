import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CADENCE_INTERVAL_SECONDS, STALE_FACTOR } from '../snapshot/contract'
import { SCANNED_AT, buildSnapshot } from '../test/factory'
import { StaleWarning } from './StaleWarning'

const THREE_HOURLY = CADENCE_INTERVAL_SECONDS['three-hourly']
const DAILY = CADENCE_INTERVAL_SECONDS.daily

function at(offsetSeconds: number): Date {
  return new Date(SCANNED_AT.getTime() + offsetSeconds * 1000)
}

describe('StaleWarning', () => {
  it('renders nothing while every list is inside its window', () => {
    const { metadata } = buildSnapshot()
    const { container } = render(<StaleWarning metadata={metadata} now={at(60)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('warns about the three-hourly list alone while the daily one is still fresh', () => {
    const { metadata } = buildSnapshot()
    render(<StaleWarning metadata={metadata} now={at(THREE_HOURLY * STALE_FACTOR + 3600)} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('One source list is out of date')
    expect(alert).toHaveTextContent(
      'data/words/4-letters.txt is scanned every 3 hours and is overdue by 1 hour.',
    )
    expect(alert).not.toHaveTextContent('data/words/5-letters.txt')
  })

  it('names every overdue list once both are past their own thresholds', () => {
    const { metadata } = buildSnapshot()
    render(<StaleWarning metadata={metadata} now={at(DAILY * STALE_FACTOR + 60)} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('2 source lists are out of date')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(alert).toHaveTextContent(
      'data/words/5-letters.txt is scanned every 24 hours and is overdue by 1 minute.',
    )
  })

  it('tells the visitor to confirm with ENS rather than trusting the shown status', () => {
    const { metadata } = buildSnapshot()
    render(<StaleWarning metadata={metadata} now={at(DAILY * STALE_FACTOR + 60)} />)
    expect(screen.getByRole('alert')).toHaveTextContent('confirm with ENS before acting on it')
  })

  it('keeps the overdue figure coarse, because a live region must not tick', () => {
    const { metadata } = buildSnapshot()
    render(<StaleWarning metadata={metadata} now={at(THREE_HOURLY * STALE_FACTOR + 3725)} />)
    // 3725 seconds past the threshold reads as the largest whole units, not 01:02:05.
    expect(screen.getByRole('alert')).toHaveTextContent('overdue by 1 hour 2 minutes')
  })
})

/**
 * The alert a stopped schedule has to raise.
 *
 * One group publishes every three hours and one every day, and a publication by
 * either merges the other group forward, so a snapshot can be minutes old while one
 * of its lists has not been queried for days. The warning is what tells a visitor
 * which of the two they are looking at.
 */
describe('StaleWarning with one stopped schedule', () => {
  it('warns about the stopped list while the snapshot itself was just published', () => {
    const { metadata } = buildSnapshot({
      sources: [
        {
          id: 'five-letters',
          path: 'data/words/5-letters.txt',
          cadence: 'daily',
          names: 1,
          lastScannedAt: new Date(SCANNED_AT.getTime() - 50 * 60 * 60 * 1000),
        },
        {
          id: 'four-letters',
          path: 'data/words/4-letters.txt',
          cadence: 'three-hourly',
          names: 3,
        },
      ],
    })
    render(<StaleWarning metadata={metadata} now={at(3600)} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('One source list is out of date')
    expect(alert).toHaveTextContent(
      'data/words/5-letters.txt is scanned every 24 hours and is overdue by 3 hours.',
    )
    // The list this run did scan is an hour old, so it must not be named.
    expect(alert).not.toHaveTextContent('data/words/4-letters.txt')
  })
})
