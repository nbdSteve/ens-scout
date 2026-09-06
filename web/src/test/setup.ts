import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * Test setup.
 *
 * Unmounting after every test is what makes the assertions here honest: a
 * component left mounted keeps its timers and its effects running, and the next
 * test would be asserting against two renders at once.
 */
afterEach(() => {
  cleanup()
})

/**
 * jsdom implements no `matchMedia` at all, so a component that asks the browser
 * what it prefers throws rather than getting an answer. This is the whole of the
 * gap being filled: every query reports no match, which is what a browser reports
 * for a preference nobody expressed, and the listener pair is real so a component
 * can subscribe and unsubscribe.
 *
 * A test that cares which way a query answers - the ambient optical loop, at
 * either breakpoint and under either motion preference - replaces this with its
 * own fake rather than reaching through it.
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (media: string): MediaQueryList => {
    const target = new EventTarget()
    return {
      media,
      matches: false,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    }
  }
}
