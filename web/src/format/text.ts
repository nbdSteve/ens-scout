/**
 * Text measurement.
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
