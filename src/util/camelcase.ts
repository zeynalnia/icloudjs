/**
 * String casing helper ported from `pyicloud/utils.py:underscore_to_camelcase`.
 */

/**
 * Transform an underscore-separated word into camelCase (or PascalCase).
 *
 * Mirrors the Python implementation exactly:
 *   words = [x.capitalize() or "_" for x in word.split("_")]
 *   if not initial_capital: words[0] = words[0].lower()
 *   return "".join(words)
 *
 * Notably, Python's `str.capitalize()` upper-cases the first character and
 * LOWER-cases the rest of each piece, and an empty piece (from a leading,
 * trailing, or doubled underscore) becomes the literal `"_"`.
 *
 * @param word           The underscore-separated input (e.g. `'foo_bar'`).
 * @param initialCapital When true, keep the first piece capitalized (PascalCase).
 * @returns The camelCased word (e.g. `'fooBar'`).
 */
export function underscoreToCamelcase(word: string, initialCapital = false): string {
  const words = word.split('_').map((piece) => capitalize(piece) || '_');

  if (!initialCapital && words.length > 0) {
    words[0] = words[0].toLowerCase();
  }

  return words.join('');
}

/**
 * Port of Python `str.capitalize()`: first character upper-cased, the rest
 * lower-cased. Returns an empty string for empty input.
 */
function capitalize(piece: string): string {
  if (piece.length === 0) {
    return '';
  }
  return piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase();
}
