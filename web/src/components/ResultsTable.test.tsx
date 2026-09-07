import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { sortResults } from '../state/filter'
import { instant } from '../test/dom'
import { buildSnapshot, SCANNED_AT } from '../test/factory'
import type { SnapshotResult } from '../snapshot/types'
import type { VerifiedName } from '../verify/types'
import { ResultsTable } from './ResultsTable'
import type { VerifyBinding } from './verification'

/**
 * The table is checked through its accessible structure, not its markup: a row is
 * found by its name's row header and a value by the column it is in. That is how a
 * screen reader reads it, and it is what a `display: block` "responsive table"
 * would quietly break.
 */

const rows = buildSnapshot().results

const CHECKED_AT = new Date('2026-03-01T12:00:00Z')
const EXPIRES_AT = new Date('2026-03-01T12:01:00Z')

function verifiedName(name: string, status: SnapshotResult['status'] = 'available'): VerifiedName {
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
    rows?: readonly SnapshotResult[]
    sort?: 'name' | 'expiry'
    desc?: boolean
    verify?: VerifyBinding | null
    now?: Date
  } = {},
): void {
  render(
    <ResultsTable
      direction={overrides.desc === true ? 'desc' : 'asc'}
      now={overrides.now ?? SCANNED_AT}
      rows={overrides.rows ?? rows}
      sort={overrides.sort ?? 'name'}
      verify={overrides.verify ?? null}
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

    // The caption is the table's accessible name, which is what a screen reader
    // arriving at it out of context is told first.
    const table = screen.getByRole('table', { name: /A record of one scan/ })
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

  /*
   * The caption must not promise a link that the gate may refuse. It says a name links
   * out once a fresh check covers it, which is the actual rule.
   */
  it('does not claim every name is a link', () => {
    mount()
    expect(
      screen.getByText(/links to the ENS app once a fresh check covers it/),
    ).toBeInTheDocument()
  })

  it('renders the rows in the order it was given, without re-sorting them', () => {
    mount({ rows: sortResults(rows, 'name', 'desc'), desc: true })

    const names = screen
      .getAllByRole('rowheader')
      .map((th) => th.querySelector('.mono')?.textContent)
    expect(names).toEqual(['ddddd.eth', 'cccc.eth', 'bbbb.eth', 'aaaa.eth'])
  })

  /*
   * The three parts of the name cell stack as separate lines, so nothing on screen
   * shows whether they are separated in the text. A reader announces them in one
   * breath, and `aaaa.eth4 characters` is what a missing space sounds like.
   */
  it('separates the name, the length, and the note in the announced cell', () => {
    mount({ verify: binding() })

    expect(screen.getByRole('rowheader', { name: /^aaaa\.eth/ })).toHaveAccessibleName(
      'aaaa.eth 4 characters No fresh check',
    )
  })

  it('adds a labelled selection column when there is a verifier', () => {
    mount({ verify: binding() })

    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Select for a fresh check', 'Name', 'Status at the scan time', 'What happens next'])
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

describe('ResultsTable outbound links', () => {
  /*
   * The rule this whole slice exists for: a recorded status does not open a
   * registration page. Not one link, in either configuration, until a check says so.
   */
  it('links no name when there is no verifier', () => {
    mount({ verify: null })
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('links no name that a fresh check has not covered', () => {
    mount({ verify: binding() })
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(within(row('aaaa.eth')).getByText('No fresh check')).toBeInTheDocument()
  })

  it('links a name a current fresh check covers, and says ENS decides', () => {
    mount({
      now: CHECKED_AT,
      verify: binding({ verified: new Map([['aaaa.eth', verifiedName('aaaa.eth')]]) }),
    })

    const link = within(row('aaaa.eth')).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://app.ens.domains/aaaa.eth')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link).toHaveAccessibleName(
      'aaaa.eth on the ENS app, which is the final authority on whether it can be registered, opens in a new tab',
    )
    // And only that name.
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('takes the link away again once the check lapses, and says so', () => {
    mount({
      now: EXPIRES_AT,
      verify: binding({ verified: new Map([['aaaa.eth', verifiedName('aaaa.eth')]]) }),
    })

    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(within(row('aaaa.eth')).getByText('Fresh check has lapsed')).toBeInTheDocument()
  })
})

describe('ResultsTable fresh status', () => {
  /*
   * The scan's answer and the fresh answer are both shown, and the fresh one carries the
   * instant it was read. They can disagree - that is the point of checking - so neither
   * may be presented as the other.
   */
  it('shows the fresh status beside the scan status, with the instant it was read', () => {
    mount({
      now: CHECKED_AT,
      verify: binding({
        verified: new Map([['ddddd.eth', verifiedName('ddddd.eth', 'available')]]),
      }),
    })

    const cell = row('ddddd.eth')
    expect(within(cell).getByText('Grace period')).toBeInTheDocument()
    expect(within(cell).getByText('Available')).toBeInTheDocument()
    expect(within(cell).getByText('Fresh check')).toBeInTheDocument()
    expect(within(cell).getByText('12:00:00 UTC')).toHaveAttribute(
      'datetime',
      '2026-03-01T12:00:00Z',
    )
  })

  /*
   * A lapsed check is still the newest thing anyone read, and its label states when. It
   * is kept rather than hidden, because hiding it would leave the page unable to say the
   * check had lapsed at all.
   */
  it('keeps a lapsed fresh status on screen with its instant', () => {
    mount({
      now: EXPIRES_AT,
      verify: binding({
        verified: new Map([['ddddd.eth', verifiedName('ddddd.eth', 'available')]]),
      }),
    })

    const cell = row('ddddd.eth')
    expect(within(cell).getByText('12:00:00 UTC')).toBeInTheDocument()
    expect(within(cell).getByText('Fresh check has lapsed')).toBeInTheDocument()
  })

  it('shows no fresh block for a name no check covered', () => {
    mount({ verify: binding() })
    expect(within(row('aaaa.eth')).queryByText('Fresh check')).toBeNull()
  })
})

describe('ResultsTable selection', () => {
  it('offers a labelled tick box per name and reports the ticked ones', async () => {
    const onToggle = vi.fn()
    mount({ verify: binding({ selected: new Set(['aaaa.eth']), onToggle }) })

    const box = within(row('aaaa.eth')).getByRole('checkbox', { name: 'Fresh check aaaa.eth' })
    expect(box).toBeChecked()
    expect(within(row('bbbb.eth')).getByRole('checkbox')).not.toBeChecked()

    await userEvent.setup().click(box)
    expect(onToggle).toHaveBeenCalledWith('aaaa.eth')
  })

  /*
   * Real `disabled`, not a click that silently does nothing. The bound is stated in the
   * bar above, so the boxes going flat is the second half of a message the visitor has
   * already been given rather than a control that stopped working.
   */
  it('disables an unticked box once the selection is full, and leaves ticked ones usable', () => {
    mount({ verify: binding({ selected: new Set(['aaaa.eth']), full: true }) })

    expect(within(row('aaaa.eth')).getByRole('checkbox')).toBeEnabled()
    expect(within(row('bbbb.eth')).getByRole('checkbox')).toBeDisabled()
  })

  it('says a check is running for the names it covers', () => {
    mount({ verify: binding({ selected: new Set(['aaaa.eth']), pending: new Set(['aaaa.eth']) }) })

    expect(within(row('aaaa.eth')).getByText('Fresh check running')).toBeInTheDocument()
    expect(within(row('bbbb.eth')).getByText('No fresh check')).toBeInTheDocument()
  })

  it('offers no tick box at all when there is no verifier', () => {
    mount({ verify: null })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })
})
