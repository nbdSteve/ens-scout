import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_BASE, MOBILE_BASE, OPTICAL_PROPERTIES } from './ambient'
import type * as Ambient from './ambient'

/**
 * The optics are tested as arithmetic first and as a loop second.
 *
 * The composition is a pure function of elapsed time, so the interesting properties -
 * determinism, the derived beam angle, and the amplitude bound that keeps the hot centre
 * off the type - need no browser at all. Only the scheduling, the freeze, and the
 * reference count need one.
 */

interface FakeMediaQueryList {
  matches: boolean
  readonly media: string
  readonly listeners: Set<() => void>
}

const lists = new Map<string, FakeMediaQueryList>()

/** Media queries are the loop's only input besides the clock, so they are the fake. */
function stubMedia(matching: readonly string[]): void {
  lists.clear()
  vi.stubGlobal('matchMedia', (media: string): MediaQueryList => {
    let list = lists.get(media)
    if (list === undefined) {
      list = { matches: matching.includes(media), media, listeners: new Set() }
      lists.set(media, list)
    }
    const found = list
    return {
      get matches() {
        return found.matches
      },
      media,
      addEventListener: (_type: string, listener: () => void) => found.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        found.listeners.delete(listener),
    } as unknown as MediaQueryList
  })
}

function setMedia(media: string, matches: boolean): void {
  const list = lists.get(media)
  if (list === undefined) {
    throw new Error(`nothing has asked about ${media} yet`)
  }
  list.matches = matches
  for (const listener of list.listeners) {
    listener()
  }
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Module state banks elapsed time on purpose, so each test gets its own copy of it. */
async function load(): Promise<typeof Ambient> {
  vi.resetModules()
  return import('./ambient')
}

function read(property: string): string {
  return document.documentElement.style.getPropertyValue(property)
}

function degrees(property: string): number {
  return Number.parseFloat(read(property))
}

/** One animation frame's worth of fake time. */
const FRAME_MS = 16

beforeEach(() => {
  stubMedia([])
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.removeAttribute('style')
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
})

describe('ambientFrame', () => {
  it('is a pure function of elapsed time', async () => {
    const { ambientFrame } = await load()
    expect(ambientFrame(12_345, DESKTOP_BASE)).toEqual(ambientFrame(12_345, DESKTOP_BASE))
    expect(ambientFrame(12_345, DESKTOP_BASE)).not.toEqual(ambientFrame(12_346, DESKTOP_BASE))
  })

  it('keeps both bright ends within their stated drift, so the light never reaches the type', async () => {
    const { ambientFrame } = await load()
    for (let seconds = 0; seconds <= 600; seconds += 0.5) {
      const frame = ambientFrame(seconds * 1000, DESKTOP_BASE)
      expect(Math.abs(frame.lx - DESKTOP_BASE.lx)).toBeLessThanOrEqual(DESKTOP_BASE.ax)
      expect(Math.abs(frame.ly - DESKTOP_BASE.ly)).toBeLessThanOrEqual(DESKTOP_BASE.ay)
      expect(Math.abs(frame.cx - DESKTOP_BASE.cx)).toBeLessThanOrEqual(DESKTOP_BASE.cax)
      expect(Math.abs(frame.cy - DESKTOP_BASE.cy)).toBeLessThanOrEqual(DESKTOP_BASE.cay)
    }
  })

  it('keeps the refraction between 0.86 and 1', async () => {
    const { ambientFrame } = await load()
    for (let seconds = 0; seconds <= 600; seconds += 0.5) {
      const { sep } = ambientFrame(seconds * 1000, DESKTOP_BASE)
      expect(sep).toBeGreaterThanOrEqual(0.86)
      expect(sep).toBeLessThanOrEqual(1)
    }
  })

  it('derives the beam angle from the two points, so the ribbon always joins them', async () => {
    const { ambientFrame } = await load()
    for (const seconds of [0, 7.5, 41, 220]) {
      const frame = ambientFrame(seconds * 1000, DESKTOP_BASE)
      const expected = (Math.atan2(frame.cy - frame.ly, frame.cx - frame.lx) * 180) / Math.PI
      expect(frame.ba).toBeCloseTo(expected, 10)
    }
  })

  it('turns the glass once every 97 seconds', async () => {
    const { ambientFrame } = await load()
    expect(ambientFrame(0, DESKTOP_BASE).cf).toBeCloseTo(212, 6)
    expect(ambientFrame(97_000, DESKTOP_BASE).cf).toBeCloseTo(212, 6)
    expect(ambientFrame(48_500, DESKTOP_BASE).cf).toBeCloseTo(32, 6)
  })
})

describe('staticFrame', () => {
  it('holds the base points with the glass square on and the refraction closed', async () => {
    const { staticFrame } = await load()
    const frame = staticFrame(DESKTOP_BASE)
    expect(frame.lx).toBe(DESKTOP_BASE.lx)
    expect(frame.ly).toBe(DESKTOP_BASE.ly)
    expect(frame.cx).toBe(DESKTOP_BASE.cx)
    expect(frame.cy).toBe(DESKTOP_BASE.cy)
    expect(frame.cf).toBe(212)
    expect(frame.sep).toBe(1)
  })

  it('derives its beam angle the same way the moving frames do', async () => {
    const { staticFrame } = await load()
    expect(staticFrame(DESKTOP_BASE).ba).toBeCloseTo(153.6874, 4)
    expect(staticFrame(MOBILE_BASE).ba).toBeCloseTo(142.125, 4)
  })
})

describe('writeFrame', () => {
  it('writes every property the stylesheet reads, with its unit', async () => {
    const { staticFrame, writeFrame } = await load()
    writeFrame(document.documentElement, staticFrame(DESKTOP_BASE))
    expect(read('--lx')).toBe('1272.0px')
    expect(read('--ly')).toBe('178.0px')
    expect(read('--cx')).toBe('1090.0px')
    expect(read('--cy')).toBe('268.0px')
    expect(read('--cf')).toBe('212.0deg')
    expect(read('--sep')).toBe('1.000')
    expect(read('--ba')).toBe('153.69deg')
    for (const property of OPTICAL_PROPERTIES) {
      expect(read(property)).not.toBe('')
    }
  })
})

describe('the loop', () => {
  it('composes the light on the first paint, before any frame has run', async () => {
    const { startAmbient } = await load()
    startAmbient()
    expect(read('--lx')).toBe('1272.0px')
    expect(read('--ba')).not.toBe('')
  })

  it('keeps moving while it runs, because being alive at rest is the point', async () => {
    const { startAmbient } = await load()
    startAmbient()
    const first = read('--lx')
    vi.advanceTimersByTime(FRAME_MS * 120)
    const later = read('--lx')
    expect(later).not.toBe(first)
    vi.advanceTimersByTime(FRAME_MS * 120)
    expect(read('--lx')).not.toBe(later)
  })

  it('composes at its own cadence, not once per animation frame', async () => {
    const { FRAME_INTERVAL_MS, startAmbient } = await load()
    startAmbient()
    /*
     * Counting the writes is the only way to see this. The composition is a pure
     * function of elapsed time, so a loop composing eight times as often looks
     * identical in the properties it leaves behind - and costs a core to do it,
     * because every write invalidates four full-viewport blended layers.
     */
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')
    const elapsedMs = 4_000
    vi.advanceTimersByTime(elapsedMs)
    const composed = writes.mock.calls.filter(([property]) => property === '--lx').length
    writes.mockRestore()

    // The bound is the cadence itself, so this stays true whatever rate the animation
    // frames arrive at. One either side allows for where the interval falls.
    const due = elapsedMs / FRAME_INTERVAL_MS
    expect(composed).toBeLessThanOrEqual(due + 1)
    expect(composed).toBeGreaterThanOrEqual(due - 1)
  })

  it('re-bases itself when the viewport crosses the mobile breakpoint', async () => {
    const { MOBILE_QUERY, startAmbient } = await load()
    stubMedia([MOBILE_QUERY])
    startAmbient()
    expect(read('--lx')).toBe('326.0px')
  })
})

describe('the loop under reduced motion', () => {
  it('holds the deliberate still and never schedules a frame', async () => {
    const { REDUCED_MOTION_QUERY, startAmbient } = await load()
    stubMedia([REDUCED_MOTION_QUERY])
    startAmbient()
    const frozen = OPTICAL_PROPERTIES.map((property) => read(property))
    expect(frozen).toEqual([
      '1272.0px',
      '178.0px',
      '1090.0px',
      '268.0px',
      '212.0deg',
      '1.000',
      '153.69deg',
    ])
    vi.advanceTimersByTime(FRAME_MS * 600)
    expect(OPTICAL_PROPERTIES.map((property) => read(property))).toEqual(frozen)
  })

  it('freezes a loop that is already running when the preference turns on', async () => {
    const { REDUCED_MOTION_QUERY, startAmbient } = await load()
    startAmbient()
    vi.advanceTimersByTime(FRAME_MS * 120)
    expect(read('--lx')).not.toBe('1272.0px')

    setMedia(REDUCED_MOTION_QUERY, true)
    const frozen = OPTICAL_PROPERTIES.map((property) => read(property))
    expect(read('--lx')).toBe('1272.0px')
    vi.advanceTimersByTime(FRAME_MS * 600)
    expect(OPTICAL_PROPERTIES.map((property) => read(property))).toEqual(frozen)
  })

  it('starts moving again if the preference is turned off', async () => {
    const { REDUCED_MOTION_QUERY, startAmbient } = await load()
    stubMedia([REDUCED_MOTION_QUERY])
    startAmbient()
    setMedia(REDUCED_MOTION_QUERY, false)
    vi.advanceTimersByTime(FRAME_MS * 120)
    expect(read('--lx')).not.toBe('1272.0px')
  })
})

describe('the loop reference count', () => {
  it('survives being started twice and torn down once, which is what StrictMode does', async () => {
    const { startAmbient, stopAmbient } = await load()
    startAmbient()
    startAmbient()
    stopAmbient()
    const first = read('--lx')
    vi.advanceTimersByTime(FRAME_MS * 120)
    expect(read('--lx')).not.toBe(first)
  })

  it('stops when the last hold goes', async () => {
    const { startAmbient, stopAmbient } = await load()
    startAmbient()
    startAmbient()
    stopAmbient()
    stopAmbient()
    const stopped = read('--lx')
    vi.advanceTimersByTime(FRAME_MS * 600)
    expect(read('--lx')).toBe(stopped)
  })

  it('ignores a release nobody took', async () => {
    const { stopAmbient } = await load()
    expect(() => {
      stopAmbient()
    }).not.toThrow()
  })
})

describe('the loop in a hidden tab', () => {
  it('stands down, and resumes the composition where it left off rather than where the clock is', async () => {
    const { startAmbient } = await load()
    startAmbient()
    vi.advanceTimersByTime(FRAME_MS * 120)
    const before = degrees('--cf')

    setHidden(true)
    vi.advanceTimersByTime(30_000)
    expect(degrees('--cf')).toBe(before)

    setHidden(false)
    vi.advanceTimersByTime(1_000)
    // Thirty seconds of the turn is 111 degrees, and the second that actually ran is
    // under four. The size of the step is the whole assertion: it shows the loop resumed
    // from the elapsed time it had banked rather than from wherever the clock had got to.
    expect(degrees('--cf')).toBeGreaterThan(before)
    expect(degrees('--cf') - before).toBeLessThan(10)
  })
})
