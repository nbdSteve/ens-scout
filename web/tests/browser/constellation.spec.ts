import { expect, test, type Page } from '@playwright/test'

import { OPTICAL_PROPERTIES } from '../../src/optics/ambient'
import { SCANNED_AT, SECOND, visit } from './support'

/**
 * The optical background, checked in a real browser.
 *
 * Everything here guards a failure that reports nothing. The background is
 * decoration, so no assertion elsewhere in the suite notices when it stops
 * blending, starts following the cursor, or keeps moving for a visitor who asked
 * for no motion. Each of those is a promise the page makes, and each is invisible
 * to every other test.
 *
 * The seven custom properties are the whole coupling between the layout and the
 * light, so they are what is sampled. Reading them from the computed style of the
 * document element reads whatever actually won - the stylesheet's reduced-motion
 * pins, or the frame the loop wrote - which is what a visitor sees.
 */

/** The seven properties, as the browser has resolved them. */
function optics(page: Page): Promise<string[]> {
  return page.evaluate((properties) => {
    const style = getComputedStyle(document.documentElement)
    return properties.map((property) => style.getPropertyValue(property).trim())
  }, OPTICAL_PROPERTIES)
}

test('the background never reacts to the pointer, the hover target, or the focused name', async ({
  page,
}) => {
  // A paused clock, so no animation frame lands between the samples and gets
  // mistaken for a reaction. The loop itself is the real one and is still
  // installed: this is not the reduced-motion path, where the stylesheet's
  // `!important` pins would mask an inline write and the check would prove
  // nothing.
  await page.clock.install({ time: new Date(SCANNED_AT) })
  await visit(page, { view: 'all' })
  /*
   * `install` alone still lets time flow, so pausing is what actually holds the
   * frame. The instant is taken from the page rather than from `SCANNED_AT`: a
   * clock may only ever be moved forward, and by the time the page has loaded it
   * is already some way past the instant it was installed at.
   */
  const loaded = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(loaded + 5 * SECOND))

  const before = await optics(page)
  // Evidence that the pause took, so every comparison below is a comparison and
  // not a coincidence.
  await page.waitForTimeout(250)
  expect(await optics(page), 'the clock was not actually paused').toEqual(before)

  /*
   * Every input path the concept's own check dispatched, in one synchronous turn
   * so the page cannot paint in the middle of it: a coordinate written by any
   * handler would be in the computed style by the time this returns.
   */
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('#results a') ?? document.body
    for (const type of [
      'pointermove',
      'mousemove',
      'pointerover',
      'mouseover',
      'pointerdown',
      'pointerup',
    ]) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 40, clientY: 640 }))
      window.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 1400, clientY: 30 }))
    }
    target.focus()
  })

  expect(await optics(page), 'a dispatched pointer or focus moved the light').toEqual(before)

  // And again through the browser's own input pipeline, which produces trusted
  // events a dispatched one cannot imitate. The click lands on the title rather
  // than on a name, because a name opens the ENS app in a new tab.
  const names = page.locator('#results').getByRole('link')
  await names.first().hover()
  await names.first().focus()
  await names.nth(1).hover()
  await page.locator('#page-title').click()

  expect(await optics(page), 'hovering, focusing, or clicking moved the light').toEqual(before)
})

test('the background is alive at rest', async ({ page }) => {
  await visit(page)

  const before = await optics(page)
  // Real time, because the point is that the loop keeps composing frames with no
  // input of any kind. The slowest of the six periods is 97s, so two seconds is
  // well inside a movement the sampling can see.
  await page.waitForTimeout(2000)

  expect(await optics(page), 'the light stood still for two seconds').not.toEqual(before)
})

test.describe('with reduced motion', () => {
  // Through `contextOptions`, which is the form this Playwright version accepts
  // and the form `keyboard.spec.ts` already uses for the same preference.
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('the background is frozen under reduced motion', async ({ page }) => {
    await visit(page)

    const before = await optics(page)
    /*
     * The existing scan in `keyboard.spec.ts` reads every transition and animation
     * duration, and a `requestAnimationFrame` loop is neither, so it would pass on
     * a page whose background was still moving. Sampling the light is what closes
     * that.
     */
    await page.waitForTimeout(1000)

    expect(await optics(page), 'the light moved for a visitor who asked for none').toEqual(before)

    // The still is a deliberate composition, not a paused one: the glass is at its
    // rest angle and the refraction is fully closed. A half-turned glass or a
    // part-open refraction would read as an animation someone had stalled.
    const [, , , , cf, sep] = before
    expect({ cf, sep }).toEqual({ cf: '212deg', sep: '1' })
  })
})

/** The area no content may occupy, in CSS pixels from the top-left of the viewport. */
const CORNER = { width: 240, height: 120 } as const

test('the page keeps no brand', async ({ page }) => {
  await visit(page)

  await expect(page).toHaveTitle('Available .eth names')

  /*
   * The accessibility tree, which is where a name survives being deleted from the
   * page: an `aria-label`, an `alt`, a `title`, or an icon's accessible name would
   * all still read the product out to a screen reader while looking clean on screen.
   * Snapshotting the whole body is what makes this a search rather than a checklist
   * of the places a name used to be.
   */
  expect(await page.locator('body').ariaSnapshot()).not.toMatch(/scout/i)
  expect(await page.locator('body').innerText()).not.toMatch(/scout/i)

  /*
   * And the corner is empty. Only elements that actually render something are
   * considered: every ancestor of the page spans this area by definition, so
   * asking about client rects alone would report the html element and prove
   * nothing. The optics are excluded because they are the paper's own light, and
   * the skip link because it is there only while it holds focus.
   */
  const inTheCorner = await page.evaluate((corner) => {
    const optics = ['beam', 'caustic', 'lens', 'spec']
    const rendersSomething = (element: Element): boolean => {
      if (element.matches('img, svg, canvas, video, input, textarea, select, button, hr')) {
        return true
      }
      return [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      )
    }
    return [...document.body.querySelectorAll('*')]
      .filter(
        (element) =>
          !element.closest('.skip-link') &&
          !optics.some((id) => element.closest(`#${id}`) !== null) &&
          rendersSomething(element),
      )
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.left < corner.width &&
          box.top < corner.height &&
          box.right > 0 &&
          box.bottom > 0
        )
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''}`)
  }, CORNER)

  expect(inTheCorner, 'something is laid out in the empty top-left corner').toEqual([])
})

test('the optics blend against the paper', async ({ page }) => {
  await visit(page)

  /*
   * `#root` is part of the optical contract. A transform, a filter, an opacity
   * below 1, an `isolation`, a blend mode, or a `contain` on it would each make a
   * stacking context, and every layer inside would then blend against that box
   * instead of against the paper. The page would go flat with no error anywhere,
   * which is why this is a test and not a comment.
   */
  expect(
    await page.evaluate(() => {
      const root = document.getElementById('root')!
      const style = getComputedStyle(root)
      return {
        parent: root.parentElement?.tagName ?? null,
        position: style.position,
        isolation: style.isolation,
        transform: style.transform,
        filter: style.filter,
        opacity: style.opacity,
        blend: style.mixBlendMode,
        contain: style.contain,
      }
    }),
  ).toEqual({
    parent: 'BODY',
    position: 'static',
    isolation: 'auto',
    transform: 'none',
    filter: 'none',
    opacity: '1',
    blend: 'normal',
    contain: 'none',
  })

  // The four layers themselves: siblings directly under that box, each carrying
  // its own blend, none of them reachable by the pointer.
  expect(
    await page.evaluate(() =>
      ['beam', 'caustic', 'lens', 'spec'].map((id) => {
        const layer = document.getElementById(id)!
        const style = getComputedStyle(layer)
        return [
          id,
          layer.parentElement?.id ?? 'none',
          style.position,
          style.mixBlendMode,
          style.pointerEvents,
          style.zIndex,
        ].join(' ')
      }),
    ),
  ).toEqual([
    'beam root fixed multiply none 0',
    'caustic root fixed multiply none 0',
    'lens root fixed multiply none 0',
    'spec root fixed screen none 0',
  ])
})
