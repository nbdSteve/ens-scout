import type { ReactNode } from 'react'

/**
 * Paging, as links.
 *
 * Each page is a distinct URL, so a page is shareable, the back button walks back
 * through the pages a visitor actually looked at, and a middle-click opens page
 * four in a new tab. Buttons that mutated state would give up all three.
 *
 * The row range is stated outside the navigation, because it describes the table
 * rather than being a way to move around it.
 */
export interface PaginationProps {
  readonly page: number
  readonly pageCount: number
  /** One-based index of the first and last row shown, from `applyQuery`. */
  readonly firstRow: number
  readonly lastRow: number
  readonly total: number
  readonly hrefForPage: (page: number) => string
}

/** A gap where page numbers were left out. */
const GAP = 'gap'

/**
 * First page, last page, and the current page with a neighbour either side. A break
 * in that run becomes one gap, so the control stays the same width whether there are
 * eight pages or eight hundred.
 *
 * A break of exactly one page is filled in instead. An ellipsis takes about as much
 * room as the number it hides, so hiding a single page costs the same width and
 * gives the visitor one fewer place to go.
 */
export function pageWindow(page: number, pageCount: number): readonly (number | typeof GAP)[] {
  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1])
  const pages = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)

  const items: (number | typeof GAP)[] = []
  let previous: number | null = null
  for (const n of pages) {
    if (previous !== null) {
      if (n - previous === 2) {
        items.push(previous + 1)
      } else if (n - previous > 2) {
        items.push(GAP)
      }
    }
    items.push(n)
    previous = n
  }
  return items
}

function formatCount(value: number): string {
  return value.toLocaleString('en-GB')
}

export function Pagination({
  page,
  pageCount,
  firstRow,
  lastRow,
  total,
  hrefForPage,
}: PaginationProps): ReactNode {
  return (
    <div className="pager">
      <p className="pager__range">
        Showing {formatCount(firstRow)} to {formatCount(lastRow)} of {formatCount(total)}{' '}
        {total === 1 ? 'name' : 'names'}
        {pageCount > 1 && (
          <>
            {' '}
            &middot; page {formatCount(page)} of {formatCount(pageCount)}
          </>
        )}
      </p>

      {pageCount > 1 && (
        <nav aria-label="Result pages">
          <ul className="pager__list">
            <li>
              {page > 1 ? (
                <a className="pager__step" href={hrefForPage(page - 1)} rel="prev">
                  Previous
                </a>
              ) : (
                // Not a link and not a disabled button: there is no previous page to
                // go to, so there is nothing here to offer or to focus.
                <span className="pager__step pager__step--off">Previous</span>
              )}
            </li>
            {pageWindow(page, pageCount).map((item, index) =>
              item === GAP ? (
                <li aria-hidden="true" className="pager__gap" key={`gap-${String(index)}`}>
                  &hellip;
                </li>
              ) : (
                <li key={item}>
                  <a
                    aria-current={item === page ? 'page' : undefined}
                    aria-label={`Page ${formatCount(item)}`}
                    className={`pager__page${item === page ? ' pager__page--current' : ''}`}
                    href={hrefForPage(item)}
                  >
                    {formatCount(item)}
                  </a>
                </li>
              ),
            )}
            <li>
              {page < pageCount ? (
                <a className="pager__step" href={hrefForPage(page + 1)} rel="next">
                  Next
                </a>
              ) : (
                <span className="pager__step pager__step--off">Next</span>
              )}
            </li>
          </ul>
        </nav>
      )}
    </div>
  )
}
