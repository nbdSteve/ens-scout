import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { MODEL_DOWNLOAD_BYTES, MODEL_VRAM_MB } from '../suggest/contract'
import {
  describeGenerateFailure,
  describeLoadFailure,
  describeSupport,
  type SuggestFailure,
} from '../suggest/failure'
import { SuggestFormatError } from '../suggest/parse'
import type { SuggestCapabilities, SuggestPhase, SuggestStore } from '../state/useSuggest'
import { SuggestModelState } from './SuggestModelState'

/**
 * What the optional model is doing, said in words, and how to stop it.
 *
 * Two claims are worth more here than the rendering. The first is that the size is on
 * screen before anything is fetched: the whole point of the grace window is that a visitor
 * can refuse a download this large, and they cannot refuse a figure they have not been
 * shown. The second is that every phase has a sentence, and a control that describes the
 * choice rather than the implementation - a button offering to stop a download while
 * nothing is downloading is a button about the wrong thing.
 *
 * Nothing here is an error page, so the tests read the panel in each state and check what
 * it says. The failure banner is the one exception, and it is a warning beside a working
 * page rather than in place of one.
 */

/** The two figures, derived the way the component derives them rather than copied. */
const DOWNLOAD_SIZE = `${Math.round(MODEL_DOWNLOAD_BYTES / 1_000_000).toLocaleString('en-GB')} MB`
const MEMORY_SIZE = `${Math.round(MODEL_VRAM_MB).toLocaleString('en-GB')} MB`

/** Every phase, so a total map in the component is checked against a total list here. */
const EVERY_PHASE: readonly SuggestPhase[] = [
  'waiting',
  'checking',
  'loading',
  'ready',
  'generating',
  'paused',
  'cancelled',
  'disabled',
  'unavailable',
]

/** The states where something is about to be, or is being, fetched. */
const FETCHING: readonly SuggestPhase[] = ['waiting', 'checking', 'loading']

const STOPPED: readonly SuggestPhase[] = ['paused', 'cancelled', 'disabled']

interface Controls {
  readonly pause: Mock<() => void>
  readonly resume: Mock<() => void>
  readonly disable: Mock<() => void>
  readonly enable: Mock<() => void>
}

interface Options {
  readonly progress?: SuggestStore['progress']
  readonly slow?: boolean
  readonly failure?: SuggestFailure | null
  readonly cached?: boolean
  readonly capabilities?: Partial<SuggestCapabilities>
}

function controls(): Controls {
  return {
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    disable: vi.fn<() => void>(),
    enable: vi.fn<() => void>(),
  }
}

function capabilities(phase: SuggestPhase, failure: SuggestFailure | null): SuggestCapabilities {
  return {
    pause: ['waiting', 'checking', 'loading', 'ready', 'generating'].includes(phase),
    resume:
      phase === 'paused' ||
      phase === 'cancelled' ||
      (phase === 'unavailable' && failure?.retryable === true),
    disable: phase !== 'disabled',
    enable: phase === 'disabled',
  }
}

function stubStore(phase: SuggestPhase, options: Options, buttons: Controls): SuggestStore {
  const failure = options.failure ?? null
  return {
    phase,
    progress: options.progress ?? null,
    slow: options.slow ?? false,
    failure,
    cached: options.cached ?? false,
    answer: null,
    capabilities: { ...capabilities(phase, failure), ...options.capabilities },
    suggest: vi.fn<SuggestStore['suggest']>(),
    clear: vi.fn<() => void>(),
    ...buttons,
  }
}

function mount(phase: SuggestPhase, options: Options = {}): Controls {
  const buttons = controls()
  render(<SuggestModelState store={stubStore(phase, options, buttons)} />)
  return buttons
}

/**
 * Renders the panel in each phase in turn and runs the check against it.
 *
 * Each render is unmounted before the next, because these checks are about what one state
 * shows and two panels in the document at once would make every query ambiguous.
 */
function inEachPhase(phases: readonly SuggestPhase[], check: (phase: SuggestPhase) => void): void {
  for (const phase of phases) {
    const { unmount } = render(<SuggestModelState store={stubStore(phase, {}, controls())} />)
    check(phase)
    unmount()
  }
}

/*
 * Built by the classifier rather than written by hand, for the reason `VerifyBar.test.tsx`
 * gives: a hand-written `{ retryable: true }` would let the recovery tests pass while the
 * real classification disagreed with them.
 */
const REFUSED = describeGenerateFailure(new SuggestFormatError('the answer is not JSON'))
const LOAD_FAILED = describeLoadFailure(new Error('nothing familiar'))
const UNSUPPORTED = describeSupport('no-webgpu')!

describe('what the panel says it is doing', () => {
  /*
   * A sentence for every phase, checked as nine sentences rather than as nine strings:
   * what matters is that no state renders an empty line or borrows another state's words.
   */
  it('says something distinct in every phase', () => {
    const lines: string[] = []
    inEachPhase(EVERY_PHASE, () => {
      lines.push(screen.getByRole('status').textContent)
    })

    expect(lines).toHaveLength(EVERY_PHASE.length)
    expect(new Set(lines).size).toBe(EVERY_PHASE.length)
    for (const line of lines) {
      expect(line.trim().endsWith('.')).toBe(true)
    }
  })

  /*
   * A status region, so a phase change is announced without taking focus off whatever the
   * visitor is doing with the list. It says one short thing and changes only on a phase
   * change, so it does not chatter through a download.
   */
  it('announces the phase without moving focus', () => {
    mount('loading')
    expect(screen.getByRole('status')).toHaveTextContent('Downloading the optional model.')
  })

  /*
   * The three states where the model is not going to order the names all say that the
   * names are ranked anyway. That is the claim that keeps this from reading as a failure.
   */
  it('says the names are still ranked whenever the model is not in use', () => {
    inEachPhase(STOPPED, () => {
      expect(screen.getByRole('status')).toHaveTextContent(/ranked by this page instead/)
    })
  })
})

describe('the size, before anything is fetched', () => {
  /*
   * The rule the grace window exists for. In `waiting` nothing is in flight, so this is
   * the figure a visitor is being asked to agree to, and it is on screen with both
   * controls beside it.
   */
  it('states the download and the memory it needs before a load begins', () => {
    mount('waiting')

    expect(screen.getByText(new RegExp(`transfers ${DOWNLOAD_SIZE}`))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`about ${MEMORY_SIZE} of graphics`))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Do not download it' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn it off on this device' })).toBeInTheDocument()
  })

  it('says it is downloaded once, and never needed to see the names', () => {
    mount('waiting')

    expect(screen.getByText(/downloaded once/)).toBeInTheDocument()
    expect(screen.getByText(/never needed to see the names/)).toBeInTheDocument()
  })

  /*
   * A returning visitor is not told they are about to transfer two hundred megabytes they
   * already hold. The memory figure stays, because that is what the load still costs them.
   */
  it('says there is nothing to download when the model is already stored', () => {
    mount('waiting', { cached: true })

    expect(screen.getByText(/already stored in this browser/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`about ${MEMORY_SIZE} of graphics`))).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(`transfers ${DOWNLOAD_SIZE}`))).toBeNull()
  })

  it('keeps the figure on screen through the check and the load', () => {
    inEachPhase(FETCHING, () => {
      expect(screen.getByText(new RegExp(`transfers ${DOWNLOAD_SIZE}`))).toBeInTheDocument()
    })
  })

  /*
   * Once there is nothing left to fetch the figure is noise, and in the stopped states it
   * would read as an offer rather than as a description.
   */
  it('drops the figure once nothing is going to be fetched', () => {
    inEachPhase(
      EVERY_PHASE.filter((phase) => !FETCHING.includes(phase)),
      () => {
        expect(screen.queryByText(new RegExp(`transfers ${DOWNLOAD_SIZE}`))).toBeNull()
        expect(screen.queryByText(/already stored in this browser/)).toBeNull()
      },
    )
  })
})

describe('how far the load has got', () => {
  /*
   * A native progress element, so the value is exposed without this page reimplementing a
   * role. The figure beside it is the same number in words, for anyone reading the page
   * rather than hearing it.
   */
  it('exposes the fraction as a progress bar and as a figure', () => {
    mount('loading', { progress: { fraction: 0.42, text: 'Fetching model weights' } })

    expect(screen.getByRole('progressbar', { name: 'Model download' })).toHaveValue(42)
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  /*
   * Indeterminate rather than zero. A bar pinned at the left reads as stalled, and the
   * library does not always know a fraction.
   */
  it('says it is working rather than showing zero when the fraction is unknown', () => {
    mount('loading', { progress: { fraction: null, text: 'Loading shader library' } })

    expect(screen.getByRole('progressbar', { name: 'Model download' })).not.toHaveValue()
    expect(screen.getByText('Working')).toBeInTheDocument()
  })

  it('shows no bar at all when nothing is loading', () => {
    mount('waiting')
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  /*
   * The library's own progress text quotes asset paths, and the host those paths are on is
   * the one thing this page otherwise never names.
   */
  it('never shows the library’s own progress text', () => {
    mount('loading', { progress: { fraction: 0.5, text: 'Fetching param cache[3/7]: 24MB' } })

    expect(screen.queryByText(/param cache/)).toBeNull()
    expect(screen.queryByText(/24MB/)).toBeNull()
  })
})

describe('a load that is taking a while', () => {
  /*
   * Still loading, and saying so is the point: the honest message is that this is slow and
   * the names below are already ranked, not that something has failed.
   */
  it('says so, and says the names are already ranked', () => {
    mount('loading', { slow: true, progress: { fraction: 0.1, text: 'Fetching' } })

    expect(screen.getByText(/taking a while/)).toBeInTheDocument()
    expect(screen.getByText(/already[\s\n]+ranked/)).toBeInTheDocument()
  })

  /*
   * The flag outlives the load it described, so it is read together with the phase. A page
   * that had a slow load and then stopped it must not go on saying the load is slow.
   */
  it('drops the line once the load is over', () => {
    mount('cancelled', { slow: true })
    expect(screen.queryByText(/taking a while/)).toBeNull()
  })
})

describe('stopping it, and turning it off', () => {
  /*
   * One control, three honest labels. 'Stop the download' while nothing is downloading
   * would describe the implementation rather than the choice.
   */
  it('describes stopping in the visitor’s terms for the phase they are in', () => {
    const labels: readonly (readonly [SuggestPhase, string])[] = [
      ['waiting', 'Do not download it'],
      ['checking', 'Stop the download'],
      ['loading', 'Stop the download'],
      ['ready', 'Stop using it'],
      ['generating', 'Stop using it'],
    ]
    for (const [phase, label] of labels) {
      inEachPhase([phase], () => {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
      })
    }
  })

  it('stops it when asked', async () => {
    const buttons = mount('loading')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop the download' }))
    expect(buttons.pause).toHaveBeenCalledTimes(1)
  })

  /* Nothing to stop, so nothing offers to. */
  it('offers no stop control once it is already stopped', () => {
    inEachPhase(STOPPED, () => {
      expect(screen.queryByRole('button', { name: /^(Do not download it|Stop)/ })).toBeNull()
    })
  })

  /*
   * Two different promises, labelled as two. Pausing is for this page and nothing is
   * remembered; turning off is remembered on this device.
   */
  it('remembers the decision when asked to', async () => {
    const buttons = mount('waiting')

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Turn it off on this device' }))
    expect(buttons.disable).toHaveBeenCalledTimes(1)
    expect(buttons.pause).not.toHaveBeenCalled()
  })

  /*
   * A visitor who turned it off on a previous visit arrives in this state, so the only
   * durable decision on the panel has to be reversible from it.
   */
  it('offers to turn it back on once it is off, and nothing about turning it off', async () => {
    const buttons = mount('disabled')

    expect(screen.queryByRole('button', { name: 'Turn it off on this device' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn it back on' }))
    expect(buttons.enable).toHaveBeenCalledTimes(1)
  })
})

describe('starting it again', () => {
  /* Paused is the one state where the model was never refused, so the label is an offer. */
  it('offers the model itself after a pause', async () => {
    const buttons = mount('paused')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Use the model' }))
    expect(buttons.resume).toHaveBeenCalledTimes(1)
  })

  it('offers another attempt after a cancelled download', async () => {
    const buttons = mount('cancelled')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(buttons.resume).toHaveBeenCalledTimes(1)
  })

  /*
   * The rule `components/recovery.ts` states on the snapshot path: a button that cannot
   * succeed is worse than no button. Nothing about this page caused an unsupported device,
   * so there is nothing here to try again.
   */
  it('offers no retry for a failure another attempt cannot clear', () => {
    mount('unavailable', { failure: UNSUPPORTED })

    expect(UNSUPPORTED.retryable).toBe(false)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop using it' })).toBeNull()
  })

  it('offers a retry for a failure another attempt could clear', () => {
    mount('unavailable', { failure: LOAD_FAILED })

    expect(LOAD_FAILED.retryable).toBe(true)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('offers nothing to restart while it is running', () => {
    inEachPhase(['waiting', 'checking', 'loading', 'ready', 'generating'], () => {
      expect(screen.queryByRole('button', { name: /^(Try again|Use the model)$/ })).toBeNull()
    })
  })
})

describe('the failure banner', () => {
  it('uses an honest fixed heading for each failure stage', () => {
    const cases: readonly (readonly [SuggestPhase, SuggestFailure, string])[] = [
      ['unavailable', UNSUPPORTED, 'The model is unavailable here'],
      ['unavailable', LOAD_FAILED, 'The model could not be loaded'],
      ['ready', REFUSED, 'The model did not answer'],
    ]
    for (const [phase, failure, heading] of cases) {
      const { unmount } = render(
        <SuggestModelState store={stubStore(phase, { failure }, controls())} />,
      )
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
      unmount()
    }
  })

  it('carries the sentence the classifier wrote and nothing of its own about the cause', () => {
    mount('ready', { failure: REFUSED })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The model did not answer')
    expect(alert).toHaveTextContent(REFUSED.message)
  })

  /*
   * Shown even while the phase is 'ready', because a refused answer leaves the model
   * loaded and perfectly usable: what failed was one generation, and the sentence says so.
   */
  it('stays on screen while the model is loaded and idle', () => {
    mount('ready', { failure: REFUSED })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('shows no banner when nothing has failed', () => {
    mount('ready')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
