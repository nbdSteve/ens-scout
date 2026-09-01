import type { ReactNode } from 'react'
import { VIEWS } from '../state/views'

/**
 * The named views.
 *
 * Links, not tabs. Each view is a URL that can be shared and reached with the back
 * button, and `role="tablist"` would promise keyboard behaviour - arrow keys moving
 * between panels in one document - that these do not have and should not have.
 * `aria-current="page"` marks the one being shown.
 *
 * The count beside each view is how many names that view would show under the
 * filters currently in force, not the view's size in the whole snapshot. A visitor
 * who has searched should not be shown a count they will not land on.
 *
 * The spaces between the label, the count, and the announcement are text nodes of
 * the link rather than the first character of a span. An accessible name is
 * assembled from each child's own trimmed text, so a space inside a span is dropped
 * and the tab would be announced as "All names4 names match".
 */
export interface ViewTabsProps {
  readonly current: string
  readonly counts: ReadonlyMap<string, number>
  readonly hrefForView: (id: string) => string
}

export function ViewTabs({ current, counts, hrefForView }: ViewTabsProps): ReactNode {
  return (
    <nav aria-label="Views" className="views">
      <ul className="views__list">
        {VIEWS.map((view) => {
          const active = view.id === current
          const count = counts.get(view.id) ?? 0
          return (
            <li key={view.id}>
              <a
                aria-current={active ? 'page' : undefined}
                className={`views__tab${active ? ' views__tab--current' : ''}`}
                href={hrefForView(view.id)}
                title={view.summary}
              >
                {view.label} <span className="views__count">{count.toLocaleString('en-GB')}</span>{' '}
                <span className="visually-hidden">
                  {count === 1 ? 'name matches' : 'names match'}. {view.summary}
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
