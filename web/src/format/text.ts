/**
 * Text measurement and ordering.
 *
 * A `.eth` label is a sequence of characters, not of UTF-16 units, and
 * `names.Normalize` deliberately accepts non-ASCII labels. Measuring with
 * `String.prototype.length` would report 2 for a single astral character and put
 * such a label in the wrong length bucket, so length is always counted in code
 * points.
 */
export function codePointLength(text: string): number {
  // `Array.from` iterates a string by code point, which is the whole reason for
  // not reading `String.prototype.length`.
  return Array.from(text).length
}

/**
 * Compares two names the way the publisher ordered them.
 *
 * `internal/snapshot` sorts with Go's string comparison, which is UTF-8 byte order,
 * and JavaScript's `<` compares UTF-16 code units. The two agree on every basic-plane
 * character and disagree the moment a label carries one outside it: a surrogate pair
 * begins at U+D800, so the browser calls `'\u{1F680}.eth'` smaller than `'豈.eth'`
 * while the snapshot sorts them the other way round. Left alone, that rejects a
 * perfectly canonical snapshot as out of order, and where it does parse it presents an
 * order the publisher never wrote.
 *
 * Comparing code point by code point is what restores the publisher's order, because
 * UTF-8 byte order and code point order are the same order. Emoji labels are ordinary
 * in ENS, so this is the difference between reading a valid snapshot and refusing one.
 */
const SURROGATE = /[\uD800-\uDFFF]/

export function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  /*
   * A surrogate code unit is the only thing that can make the two orders disagree, so
   * without one the built-in comparison is already the publisher's order and is used as
   * it stands. That is every label in the committed word lists. This comparator runs on
   * the order of n log n times each time the list is re-sorted, which is once per
   * keystroke in the search box, and the walk below allocates an iterator result per
   * code point; the two scans that decide this cost far less than paying that for
   * strings where it can make no difference.
   */
  if (!SURROGATE.test(left) && !SURROGATE.test(right)) {
    return left < right ? -1 : 1
  }
  // The string iterator yields whole code points, which is what makes the surrogate
  // pair a single value rather than two units that sort below U+E000.
  const a = left[Symbol.iterator]()
  const b = right[Symbol.iterator]()
  for (;;) {
    const x = a.next()
    const y = b.next()
    if (x.done === true) {
      return y.done === true ? 0 : -1
    }
    if (y.done === true) {
      return 1
    }
    const cx = x.value.codePointAt(0) ?? 0
    const cy = y.value.codePointAt(0) ?? 0
    if (cx !== cy) {
      return cx < cy ? -1 : 1
    }
  }
}
