import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { STATUS_DESCRIPTION } from '../snapshot/lifecycle'
import { buildSnapshot } from '../test/factory'
import { SummaryCounts } from './SummaryCounts'

describe('SummaryCounts', () => {
  it('reports the publisher totals, in the published status order', () => {
    const { metadata } = buildSnapshot()
    render(<SummaryCounts metadata={metadata} />)

    expect(screen.getByText('4 names checked')).toBeInTheDocument()
    const labels = screen.getAllByRole('term').map((term) => term.textContent.split(' - ')[0])
    expect(labels).toEqual(['Expiring soon', 'Grace period', 'Premium', 'Available'])
  })

  it('leaves out a status no name is in, rather than showing a zero', () => {
    const { metadata } = buildSnapshot()
    render(<SummaryCounts metadata={metadata} />)
    expect(
      screen.queryByText(`- ${STATUS_DESCRIPTION.registered}`, { exact: false }),
    ).not.toBeInTheDocument()
  })

  it('explains each status in words, so colour is never the only signal', () => {
    const { metadata } = buildSnapshot()
    render(<SummaryCounts metadata={metadata} />)
    expect(screen.getByText(`- ${STATUS_DESCRIPTION.available}`)).toBeInTheDocument()
  })

  it('says so plainly when a scan checked nothing', () => {
    const { metadata } = buildSnapshot({
      results: [],
      sources: [
        { id: 'five-letters', path: 'data/words/5-letters.txt', cadence: 'daily', names: 0 },
      ],
    })
    render(<SummaryCounts metadata={metadata} />)

    expect(screen.getByText('0 names checked')).toBeInTheDocument()
    expect(screen.getByText(/nothing to summarize/)).toBeInTheDocument()
    expect(screen.queryAllByRole('term')).toHaveLength(0)
  })

  it('uses the singular for one name', () => {
    const { metadata } = buildSnapshot({
      results: [{ name: 'aaaa.eth', status: 'available' }],
      sources: [
        { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'three-hourly', names: 1 },
      ],
      expectedIntervalSeconds: 3 * 60 * 60,
      staleAfterSeconds: 6 * 60 * 60,
    })
    render(<SummaryCounts metadata={metadata} />)
    expect(screen.getByText('1 name checked')).toBeInTheDocument()
  })
})
