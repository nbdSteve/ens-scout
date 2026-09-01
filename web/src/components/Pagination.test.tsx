import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseQuery, serializeQuery } from '../state/query'
import { useUrlState } from '../state/useUrlState'
import { Pagination, pageWindow } from './Pagination'

/**
 * Two things are tested here. The window is arithmetic and is tested directly. The
 * links are tested through the real URL state, because the point of paging by link
 * rather than by button is that the address bar holds the page a visitor is on -
 * so what each link's `href` actually says is the behaviour, not an implementation
 * detail.
 *
 * The links are read rather than clicked: jsdom does not navigate, and asserting on
 * the `href` checks the same string a middle-click or a copied link would use.
 */

/** Gaps are compared as an ellipsis, so the test does not depend on the sentinel. */
function shape(page: number, pageCount: number): (number | '…')[] {
  return pageWindow(page, pageCount).map((item) => (typeof item === 'number' ? item : '…'))
}

describe('pageWindow', () => {
  it('lists every page while they all fit', () => {
    expect(shape(1, 1)).toEqual([1])
    expect(shape(2, 3)).toEqual([1, 2, 3])
    expect(shape(1, 4)).toEqual([1, 2, 3, 4])
  })

  it('keeps the ends, the current page, and one neighbour either side', () => {
    expect(shape(5, 20)).toEqual([1, '…', 4, 5, 6, '…', 20])
  })

  it('leaves out the gap when the run already touches an end', () => {
    expect(shape(2, 20)).toEqual([1, 2, 3, '…', 20])
    expect(shape(19, 20)).toEqual([1, '…', 18, 19, 20])
  })

  it('fills a gap that would hide a single page, which costs the same width', () => {
    expect(shape(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(shape(4, 8)).toEqual([1, 2, 3, 4, 5, '…', 8])
  })

  it('stays the same width whether there are eight pages or eight hundred', () => {
    expect(shape(400, 800)).toHaveLength(shape(4, 8).length)
  })
})

/** The real URL state behind the real component. */
function Harness({
  page,
  pageCount,
  total,
}: {
  page: number
  pageCount: number
  total: number
}): ReactNode {
  const { hrefFor } = useUrlState()
  return (
    <Pagination
      firstRow={(page - 1) * 50 + 1}
      hrefForPage={(n) => hrefFor({ page: n })}
      lastRow={Math.min(page * 50, total)}
      page={page}
      pageCount={pageCount}
      total={total}
    />
  )
}

function mount(search = '', page = 1, pageCount = 20, total = 980): void {
  window.history.replaceState(null, '', `/${search}`)
  render(<Harness page={page} pageCount={pageCount} total={total} />)
}

/** What state this link would put the page in, read back through the parser. */
function stateOf(link: HTMLElement): ReturnType<typeof parseQuery>['state'] {
  const href = link.getAttribute('href') ?? ''
  return parseQuery(new URL(href, 'https://example.test/').search).state
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('Pagination range', () => {
  it('states which rows are shown, outside the navigation', () => {
    mount('?page=2', 2)

    const range = screen.getByText(/Showing 51 to 100 of 980 names/)
    expect(range).toBeInTheDocument()
    expect(range).toHaveTextContent('page 2 of 20')
    // It describes the table, so it is not part of the way to move around it.
    expect(range.closest('nav')).toBeNull()
  })

  it('is the whole story when there is only one page, and offers no navigation', () => {
    mount('', 1, 1, 12)

    expect(screen.getByText('Showing 1 to 12 of 12 names')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})

describe('Pagination links', () => {
  it('writes each page into the link and leaves page one out of it', () => {
    mount('?view=premium&page=4', 4)

    const nav = screen.getByRole('navigation', { name: 'Result pages' })
    expect(within(nav).getByRole('link', { name: 'Page 1' })).toHaveAttribute(
      'href',
      '?view=premium',
    )
    expect(within(nav).getByRole('link', { name: 'Page 5' })).toHaveAttribute(
      'href',
      '?view=premium&page=5',
    )
  })

  it('round trips through the parser, so every link reproduces the page it names', () => {
    mount('?q=zap&page=4', 4)

    for (const number of [1, 3, 5, 20]) {
      const link = screen.getByRole('link', { name: `Page ${String(number)}` })
      const state = stateOf(link)
      expect(state.page).toBe(number)
      // Paging must not silently drop the rest of the query.
      expect(state.search).toBe('zap')
      expect(serializeQuery(state)).toBe(link.getAttribute('href')?.replace(/^\.\//, ''))
    }
  })

  it('marks the page being shown', () => {
    mount('?page=4', 4)

    expect(screen.getByRole('link', { name: 'Page 4' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Page 3' })).not.toHaveAttribute('aria-current')
  })

  it('offers a step either side, marked up as such', () => {
    mount('?page=4', 4)

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('rel', 'prev')
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('rel', 'next')
  })

  it('renders a step with nowhere to go as neither a link nor a focus stop', () => {
    mount('', 1)

    expect(screen.queryByRole('link', { name: 'Previous' })).not.toBeInTheDocument()
    const previous = screen.getByText('Previous')
    expect(previous.tagName).toBe('SPAN')
    expect(previous).not.toHaveAttribute('tabindex')
    expect(screen.getByRole('link', { name: 'Next' })).toBeInTheDocument()
  })

  it('renders the last-page step the same way', () => {
    mount('?page=20', 20)

    expect(screen.queryByRole('link', { name: 'Next' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '?page=19')
  })

  it('hides the gaps, which carry nothing a screen reader needs', () => {
    mount('?page=10', 10)

    const gaps = screen.getAllByText('…')
    expect(gaps).toHaveLength(2)
    for (const gap of gaps) {
      expect(gap).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
