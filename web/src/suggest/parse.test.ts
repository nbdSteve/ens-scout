import { describe, expect, it } from 'vitest'
import { SUGGESTIONS_MAX } from './contract'
import { parseSuggestions, SuggestFormatError } from './parse'
import type { Suggestion } from './shortlist'

const ALLOWED: readonly Suggestion[] = [
  { name: 'moss.eth', label: 'moss', reason: 'It is one of this vibe’s own words.' },
  { name: 'reed.eth', label: 'reed', reason: 'Shares “reed” with the vibe you chose.' },
  { name: 'silt.eth', label: 'silt', reason: 'Nothing matched, so this is ranked on length.' },
]

function answer(picks: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ picks })
}

function refusal(text: string): string {
  try {
    parseSuggestions(text, ALLOWED)
  } catch (cause) {
    expect(cause).toBeInstanceOf(SuggestFormatError)
    return (cause as Error).message
  }
  throw new Error('the answer was accepted, and this test exists because it must not be')
}

describe('an answer this build accepts', () => {
  it('selects repository-owned suggestions in the model’s order', () => {
    expect(parseSuggestions(answer([{ name: 'reed.eth' }, { name: 'moss.eth' }]), ALLOWED)).toEqual(
      [ALLOWED[1], ALLOWED[0]],
    )
  })

  it('accepts fewer picks than the bound', () => {
    expect(parseSuggestions(answer([{ name: 'moss.eth' }]), ALLOWED)).toEqual([ALLOWED[0]])
  })
})

describe('names the model was not offered', () => {
  it('refuses a name outside the exact shortlist', () => {
    expect(refusal(answer([{ name: 'vitalik.eth' }]))).toBe(
      'pick 1 names a name that was not offered',
    )
  })

  it('refuses the whole answer when one pick is outside the shortlist', () => {
    expect(refusal(answer([{ name: 'moss.eth' }, { name: 'nobody.eth' }]))).toBe(
      'pick 2 names a name that was not offered',
    )
  })

  it('refuses case variants, bare labels, and subdomains', () => {
    expect(refusal(answer([{ name: 'Moss.eth' }]))).toBe(
      'pick 1’s name must be lowercase, got "Moss.eth"',
    )
    expect(refusal(answer([{ name: 'moss' }]))).toBe(
      'pick 1’s name must be a .eth name, got "moss"',
    )
    expect(refusal(answer([{ name: 'sub.moss.eth' }]))).toBe(
      'pick 1’s name must be a second-level name, got "sub.moss.eth"',
    )
  })

  it('refuses the same name twice', () => {
    expect(refusal(answer([{ name: 'moss.eth' }, { name: 'moss.eth' }]))).toBe(
      'pick 2 repeats a name',
    )
  })
})

describe('generated prose never enters a suggestion', () => {
  it('refuses control characters before any normalization could remove them', () => {
    expect(refusal(answer([{ name: 'moss.eth\n' }]))).toBe(
      'pick 1’s name contains characters that cannot be displayed',
    )
  })

  it('refuses qualified names in prose, including case variants and subdomains', () => {
    const generated =
      '\nA close fit; try Vitalik.ETH or sub.moss.eth instead, because moss.eth is available.'
    const message = refusal(answer([{ name: 'moss.eth', reason: generated }]))

    expect(message).toBe('pick 1 has an unexpected field "reason"')
    expect(message).not.toContain('Vitalik')
    expect(message).not.toContain('sub.moss.eth')
  })

  it('refuses every field that could carry lifecycle, registration, expiry, price, or sale claims', () => {
    const claims = [
      'Available to register now.',
      'Already registered.',
      'Expires tomorrow.',
      'The price is low.',
      'For sale today.',
    ]
    for (const reason of claims) {
      const message = refusal(answer([{ name: 'moss.eth', reason }]))
      expect(message).toBe('pick 1 has an unexpected field "reason"')
      expect(message).not.toContain(reason)
    }
  })
})

describe('answers that are not the shape that was asked for', () => {
  it('refuses prose around the JSON', () => {
    expect(refusal('Here you go:\n```json\n{"picks":[]}\n```')).toBe('the answer is not JSON')
  })

  it('refuses an empty string and non-object JSON values', () => {
    expect(refusal('')).toBe('the answer is not JSON')
    expect(refusal('[]')).toBe('the answer must be an object')
    expect(refusal('null')).toBe('the answer must be an object')
    expect(refusal('"picks"')).toBe('the answer must be an object')
  })

  it('refuses fields the schema does not name', () => {
    expect(refusal(JSON.stringify({ picks: [{ name: 'moss.eth' }], confidence: 'high' }))).toBe(
      'the answer has an unexpected field "confidence"',
    )
    expect(refusal(answer([{ name: 'moss.eth', score: 1 }]))).toBe(
      'pick 1 has an unexpected field "score"',
    )
  })

  it('refuses missing, empty, and oversized pick lists', () => {
    expect(refusal(JSON.stringify({ picks: 'moss.eth' }))).toBe(
      'the answer’s picks must be an array',
    )
    expect(refusal(answer([]))).toBe('the answer names no picks')
    expect(
      refusal(answer(Array.from({ length: SUGGESTIONS_MAX + 1 }, () => ({ name: 'moss.eth' })))),
    ).toBe(`the answer names more than ${String(SUGGESTIONS_MAX)} picks`)
  })

  it('refuses malformed pick values and names', () => {
    expect(refusal(JSON.stringify({ picks: ['moss.eth'] }))).toBe('pick 1 must be an object')
    expect(refusal(answer([{}]))).toBe('pick 1’s name must be a string')
    expect(refusal(answer([{ name: 3 }]))).toBe('pick 1’s name must be a string')
  })
})

describe('the error every refusal raises', () => {
  it('is a SuggestFormatError and nothing else', () => {
    let raised: unknown
    try {
      parseSuggestions('nonsense', ALLOWED)
    } catch (cause) {
      raised = cause
    }
    expect(raised).toBeInstanceOf(SuggestFormatError)
    expect((raised as Error).name).toBe('SuggestFormatError')
  })

  it('quotes nothing the model generated', () => {
    const message = refusal('this is not JSON, and here is a secret: hunter2')
    expect(message).toBe('the answer is not JSON')
    expect(message).not.toContain('hunter2')
  })
})
