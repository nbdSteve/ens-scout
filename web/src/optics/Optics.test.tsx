import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OPTICAL_PROPERTIES } from './ambient'
import { Optics } from './Optics'

/**
 * Two things are worth a test here, and the component does nothing else.
 *
 * The layers must be siblings with no element around them, because a wrapper is a
 * stacking group and `mix-blend-mode` would then composite against it instead of
 * against the paper. That failure is silent - the background simply goes flat -
 * so the shape of the tree is asserted rather than described.
 *
 * And mounting has to start the loop and unmounting has to stop it. The loop
 * writes to `document.documentElement`, which outlives any one render, so a
 * component that forgot its cleanup would leave a frame running for the rest of
 * the session with nothing to show it.
 */

/** Waits for real animation frames, which is what the loop is scheduled on. */
async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })
  }
}

function written(): string[] {
  const style = document.documentElement.style
  return OPTICAL_PROPERTIES.map((property) => style.getPropertyValue(property)).filter(
    (value) => value !== '',
  )
}

function clearWritten(): void {
  for (const property of OPTICAL_PROPERTIES) {
    document.documentElement.style.removeProperty(property)
  }
}

afterEach(() => {
  clearWritten()
})

describe('Optics', () => {
  it('renders the four layers as siblings, with nothing wrapping them', () => {
    const { container } = render(<Optics />)
    expect([...container.children].map((child) => child.id)).toEqual([
      'beam',
      'caustic',
      'lens',
      'spec',
    ])
  })

  it('gives every layer the parts the stylesheet paints', () => {
    const { container } = render(<Optics />)
    for (const selector of [
      '#beam > .ribbon',
      '#beam > .striae',
      '#caustic > .knot',
      '#caustic > .rings',
      '#lens > .layer.cast',
      '#lens > .layer.body',
      '#lens > .layer.rim',
      '#spec > .glass',
      '#spec > .hot',
    ]) {
      expect(container.querySelectorAll(selector)).toHaveLength(1)
    }
  })

  it('keeps the whole background out of the accessibility tree', () => {
    const { container } = render(<Optics />)
    for (const child of container.children) {
      expect(child).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('composes a frame on the first paint rather than on the first callback', () => {
    render(<Optics />)
    expect(written()).toHaveLength(OPTICAL_PROPERTIES.length)
  })

  it('stops writing once it is unmounted', async () => {
    const view = render(<Optics />)
    await frames(1)
    view.unmount()
    clearWritten()
    await frames(3)
    expect(written()).toEqual([])
  })
})
