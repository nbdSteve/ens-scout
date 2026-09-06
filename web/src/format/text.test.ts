import { describe, expect, it } from 'vitest'
import { codePointLength, compareNames } from './text'

/**
 * The name comparator is the browser's copy of one rule the publisher owns: the
 * canonical order a snapshot's results are written in. The parser refuses a snapshot
 * that disagrees with it and the list re-sorts by it, so a comparator that orders
 * names differently from `internal/snapshot` is not a cosmetic difference - it either
 * rejects a valid scan or shows an order that was never published.
 */

/** The order the same labels sort into under Go's byte-wise string comparison. */
const GO_ORDER = ['aaaa.eth', 'zap.eth', 'zzzz.eth', 'été.eth', '豈.eth', '\u{1f680}.eth']

describe('compareNames', () => {
  it('orders ASCII names the way any comparison would', () => {
    expect(compareNames('aaaa.eth', 'bbbb.eth')).toBeLessThan(0)
    expect(compareNames('bbbb.eth', 'aaaa.eth')).toBeGreaterThan(0)
    expect(compareNames('zap.eth', 'zap.eth')).toBe(0)
  })

  it('treats a shorter name that is a prefix of a longer one as the smaller', () => {
    expect(compareNames('zap.eth', 'zapp.eth')).toBeLessThan(0)
    expect(compareNames('zapp.eth', 'zap.eth')).toBeGreaterThan(0)
  })

  it('sorts a supplementary-plane label above the basic plane, as UTF-8 bytes do', () => {
    /*
     * The whole reason this function exists. `豈` is three UTF-8 bytes starting
     * EF and `\u{1f680}` is four starting F0, so the publisher writes the rocket last.
     * A UTF-16 comparison writes it first, because its first code unit is a surrogate
     * at U+D83D and that is below U+F900.
     */
    expect(['\u{f900}.eth', '\u{1f680}.eth'].sort()).toEqual(['\u{1f680}.eth', '\u{f900}.eth'])
    expect(compareNames('\u{1f680}.eth', '豈.eth')).toBeGreaterThan(0)
    expect(compareNames('豈.eth', '\u{1f680}.eth')).toBeLessThan(0)
  })

  it('reproduces the publisher order for a mixed list, which `<` does not', () => {
    const shuffled = [...GO_ORDER].reverse()
    expect([...shuffled].sort(compareNames)).toEqual(GO_ORDER)
    // Evidence that the comparator is doing work: the built-in comparison disagrees.
    expect([...shuffled].sort()).not.toEqual(GO_ORDER)
  })

  it('is a total order, so a sort using it is stable whatever it starts from', () => {
    for (const left of GO_ORDER) {
      for (const right of GO_ORDER) {
        const forwards = compareNames(left, right)
        const backwards = compareNames(right, left)
        // Summed rather than negated, so the equal case is not an assertion about
        // whether zero came back signed.
        expect(Math.sign(forwards) + Math.sign(backwards)).toBe(0)
        expect(forwards === 0).toBe(left === right)
      }
    }
  })
})

describe('codePointLength', () => {
  it('counts an astral character once', () => {
    expect(codePointLength('zap')).toBe(3)
    expect(codePointLength('\u{1f680}')).toBe(1)
    expect('\u{1f680}'.length).toBe(2)
  })
})
