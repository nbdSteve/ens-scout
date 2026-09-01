import type { MatcherFunction } from '@testing-library/dom'

/**
 * Queries shared by the component tests.
 */

/**
 * The recorded instant as a visitor reads it.
 *
 * `Countdown` renders the instant as two spans inside one `<time>`, so the only
 * place a narrow column can break it is between the date and the clock. Testing
 * Library's default text matcher reads an element's own text nodes and ignores
 * nested ones, so asking for `2026-03-04 15:04:05 UTC` finds nothing even though
 * that is exactly what is on the screen. Matching the whole text content of the
 * `<time>` asks the question the visitor would, and restricting it to `<time>`
 * keeps every ancestor that also contains the instant out of the result.
 */
export function instant(text: string): MatcherFunction {
  return (_content, element) => element?.tagName === 'TIME' && element.textContent === text
}
