import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CADENCE_INTERVAL_SECONDS, STALE_FACTOR } from '../snapshot/contract'
import { SCANNED_AT, buildSnapshot } from '../test/factory'
import { SnapshotStatus } from './SnapshotStatus'

const THREE_HOURLY = CADENCE_INTERVAL_SECONDS['three-hourly']

function at(offsetSeconds: number): Date {
  return new Date(SCANNED_AT.getTime() + offsetSeconds * 1000)
}

describe('SnapshotStatus', () => {
  it('shows the exact scan instant in UTC, machine-readable as well as readable', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(7200)}
        origin="fixture"
        snapshot={buildSnapshot()}
      />,
    )

    const shown = screen.getAllByText('2026-03-01 12:00:00 UTC')
    expect(shown[0]).toHaveAttribute('datetime', '2026-03-01T12:00:00Z')
    expect(screen.getByText('2 hours ago')).toBeInTheDocument()
  })

  it('explains a reader clock behind the scan instead of showing a negative age', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(-7200)}
        origin="fixture"
        snapshot={buildSnapshot()}
      />,
    )

    expect(screen.getByText(/clock is behind the scan time/)).toBeInTheDocument()
  })

  it('says where the shown copy came from', () => {
    render(
      <SnapshotStatus
        cachedAt={at(30)}
        confirmedCurrent={false}
        now={at(3600)}
        origin="cache"
        snapshot={buildSnapshot()}
      />,
    )

    expect(screen.getByText(/Stored in this browser/)).toBeInTheDocument()
    expect(screen.getByText('59 minutes ago')).toBeInTheDocument()
    expect(screen.queryByText(/Confirmed as the current snapshot/)).not.toBeInTheDocument()
  })

  it('says when the read API confirmed the copy is current', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent
        now={at(60)}
        origin="network"
        snapshot={buildSnapshot()}
      />,
    )

    expect(screen.getByText(/Read API/)).toBeInTheDocument()
    expect(screen.getByText('Confirmed as the current snapshot.')).toBeInTheDocument()
  })

  it('states each list schedule in words, not only in colour', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(THREE_HOURLY * STALE_FACTOR + 3600)}
        origin="fixture"
        snapshot={buildSnapshot()}
      />,
    )

    const groups = screen.getAllByRole('listitem')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveTextContent('On schedule')
    expect(groups[0]).toHaveTextContent('1 name, scanned every 24 hours')
    expect(groups[1]).toHaveTextContent('Out of date')
    expect(groups[1]).toHaveTextContent('Overdue by 1 hour.')
  })

  it('counts down to the next scan while a list is on schedule', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(3600)}
        origin="fixture"
        snapshot={buildSnapshot()}
      />,
    )

    expect(screen.getByText('Next scan due within 2 hours.')).toBeInTheDocument()
    expect(screen.getByText('Next scan due within 23 hours.')).toBeInTheDocument()
  })

  it('separates publication from the scan it published', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(60)}
        origin="fixture"
        snapshot={buildSnapshot()}
      />,
    )

    expect(screen.getByText(/Publication is when the scan was stored/)).toBeInTheDocument()
  })
})

/**
 * A list whose own schedule has stopped, in a snapshot the other group is still
 * publishing. The card has to say the stopped list is out of date and has to show
 * the instant that makes that verifiable, because the scan time at the top of the
 * card belongs to the group that is still running.
 */
describe('SnapshotStatus per-list scan instants', () => {
  const STOPPED = new Date(SCANNED_AT.getTime() - 50 * 60 * 60 * 1000)

  function stoppedDailyList() {
    return buildSnapshot({
      sources: [
        {
          id: 'five-letters',
          path: 'data/words/5-letters.txt',
          cadence: 'daily',
          names: 1,
          lastScannedAt: STOPPED,
        },
        {
          id: 'four-letters',
          path: 'data/words/4-letters.txt',
          cadence: 'three-hourly',
          names: 3,
        },
      ],
    })
  }

  it('calls out the stopped list and dates it from its own scan', () => {
    render(
      <SnapshotStatus
        cachedAt={null}
        confirmedCurrent={false}
        now={at(3600)}
        origin="fixture"
        snapshot={stoppedDailyList()}
      />,
    )

    const groups = screen.getAllByRole('listitem')
    expect(groups[0]).toHaveTextContent('Out of date')
    expect(groups[0]).toHaveTextContent('Last scanned 2026-02-27 10:00:00 UTC')
    expect(groups[0]).toHaveTextContent('Overdue by 3 hours.')

    // The list the run did scan is dated from the scan time and stays on schedule.
    expect(groups[1]).toHaveTextContent('On schedule')
    expect(groups[1]).toHaveTextContent('Last scanned 2026-03-01 12:00:00 UTC')
  })
})
