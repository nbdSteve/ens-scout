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
