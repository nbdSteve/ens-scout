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
