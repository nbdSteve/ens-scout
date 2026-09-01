import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { sortResults } from '../state/filter'
import { instant } from '../test/dom'
import { buildSnapshot, SCANNED_AT } from '../test/factory'
import type { SnapshotResult } from '../snapshot/types'
import { ResultsTable } from './ResultsTable'

/**
 * The table is checked through its accessible structure, not its markup: a row is
 * found by its name's row header and a value by the column it is in. That is how a
 * screen reader reads it, and it is what a `display: block` "responsive table"
 * would quietly break.
 */

const rows = buildSnapshot().results

function mount(
  overrides: { rows?: readonly SnapshotResult[]; sort?: 'name' | 'expiry'; desc?: boolean } = {},
): void {
  render(
    <ResultsTable
      direction={overrides.desc === true ? 'desc' : 'asc'}
      now={SCANNED_AT}
      rows={overrides.rows ?? rows}
      sort={overrides.sort ?? 'name'}
    />,
  )
}

/** The row whose row header is this name. */
function row(name: string): HTMLElement {
  return screen.getByRole('rowheader', { name: new RegExp(name) }).closest('tr') as HTMLElement
}

describe('ResultsTable structure', () => {
  it('is a real table with a caption, three column headers, and a row header per name', () => {
    mount()

    const table = screen.getByRole('table', { name: /what the scan recorded/ })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Status at the scan time', 'What happens next'])
    expect(within(table).getAllByRole('rowheader')).toHaveLength(rows.length)
  })

  it('tells the visitor the table is a record, not a fresh check', () => {
    mount()
    expect(
      screen.getByText(/not a fresh check.*only authority on whether it can be registered/s),
    ).toBeInTheDocument()
  })

  it('renders the rows in the order it was given, without re-sorting them', () => {
    mount({ rows: sortResults(rows, 'name', 'desc'), desc: true })

    const names = screen.getAllByRole('rowheader').map((th) => th.textContent.split(' ')[0])
    expect(names).toEqual(['ddddd.eth', 'cccc.eth', 'bbbb.eth', 'aaaa.eth'])
  })
})

describe('ResultsTable sort reporting', () => {
  it('reports the name order on the name column', () => {
    mount({ sort: 'name', desc: true })

    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(screen.getByRole('columnheader', { name: 'What happens next' })).toHaveAttribute(
      'aria-sort',
      'none',
    )
  })

  it('reports a date order on the boundary column, which is what every date sort orders by', () => {
    mount({ sort: 'expiry' })

    expect(screen.getByRole('columnheader', { name: 'What happens next' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none')
  })
})

describe('ResultsTable rows', () => {
  it('links each name to the ENS app and says the link leaves the page', () => {
    mount()

    const link = within(row('aaaa.eth')).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://app.ens.domains/aaaa.eth')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link).toHaveAccessibleName('aaaa.eth on the ENS app, opens in a new tab')
  })

  it('states the label length without the suffix', () => {
    mount()

    expect(within(row('aaaa.eth')).getByText('4 characters')).toBeInTheDocument()
    expect(within(row('ddddd.eth')).getByText('5 characters')).toBeInTheDocument()
  })

  it('shows the status the scan recorded, in words as well as in colour', () => {
    mount()

    expect(within(row('aaaa.eth')).getByText('Available')).toBeInTheDocument()
    expect(within(row('ddddd.eth')).getByText('Grace period')).toBeInTheDocument()
  })

  it('counts down to the timestamp that matches the published status', () => {
    mount()

    // grace-period counts down to grace_ends, never to a grace end derived from
    // the expiry beside it.
    expect(within(row('ddddd.eth')).getByText('grace period ends')).toBeInTheDocument()
    expect(
      within(row('ddddd.eth')).getByText(instant('2026-05-21 00:00:00 UTC')),
    ).toBeInTheDocument()
    expect(within(row('bbbb.eth')).getByText('premium ends')).toBeInTheDocument()
    expect(
      within(row('bbbb.eth')).getByText(instant('2026-03-05 00:00:00 UTC')),
    ).toBeInTheDocument()
  })

  it('says why a name has no date instead of showing an empty cell', () => {
    mount({
      rows: buildSnapshot({
        results: [
          { name: 'aaaa.eth', status: 'available' },
          { name: 'bbbb.eth', status: 'unknown' },
        ],
        sources: [
          {
            id: 'four-letters',
            path: 'data/words/4-letters.txt',
            cadence: 'three-hourly',
            names: 2,
          },
        ],
        expectedIntervalSeconds: 3 * 60 * 60,
        staleAfterSeconds: 6 * 60 * 60,
      }).results,
    })

    expect(
      within(row('aaaa.eth')).getByText(/Confirm the current price on the ENS app/),
    ).toBeInTheDocument()
    expect(within(row('bbbb.eth')).getByText(/no usable expiry/)).toBeInTheDocument()
  })
})
