/**
 * Date parsing helpers ported from `pyicloud/services/drive.py:_date_to_utc`
 * and the Ubiquity node `modified` field parsing.
 *
 * iCloud Drive returns timestamps either already in UTC (suffixed with `Z`)
 * or carrying a California offset (`-07:00` / `-08:00`). Per architecture map
 * §3.1, `dateModified` is usually `Z` while `dateChanged` / `dateCreated`
 * carry an offset that must be subtracted to normalize to UTC.
 */

// Matches a trailing numeric offset, e.g. `...T12:34:56-07:00` or `...+05:30`.
// Group 1 = base datetime (no offset, no Z), group 2 = signed hours, group 3 = minutes.
const OFFSET_RE = /^(.+?)([+-]\d+):(\d\d)$/;

// Matches a bare `...T12:34:56Z` (already UTC) datetime.
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

// Matches a naive `...T12:34:56` datetime (the offset-stripped base).
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Convert an iCloud Drive timestamp string into a UTC `Date`.
 *
 * Mirrors Python `_date_to_utc`:
 *   - Falsy input -> `null`.
 *   - No offset present (already UTC, `...Z`) -> parse as UTC directly.
 *   - Offset present -> parse the naive base as UTC, then SUBTRACT the offset
 *     (e.g. a `-07:00` California wall-clock time becomes UTC by adding 7h;
 *     subtracting a negative offset adds time — matching `base - diff`).
 *
 * The resulting `Date` represents the correct absolute instant in UTC.
 *
 * @param date The raw timestamp string from the Drive API, or null/undefined.
 * @returns A `Date` in UTC, or `null` when the input is falsy.
 */
export function dateToUtc(date: string | null | undefined): Date | null {
  if (!date) {
    return null;
  }

  const offsetMatch = OFFSET_RE.exec(date);
  if (!offsetMatch) {
    // Already in UTC: `%Y-%m-%dT%H:%M:%SZ`.
    const utcMatch = UTC_RE.exec(date);
    if (!utcMatch) {
      throw new RangeError(`Unparseable Drive date: ${date}`);
    }
    return buildUtcDate(utcMatch);
  }

  const naiveMatch = NAIVE_RE.exec(offsetMatch[1]);
  if (!naiveMatch) {
    throw new RangeError(`Unparseable Drive date base: ${date}`);
  }

  // Treat the offset-stripped base as a UTC wall clock, then subtract the
  // offset to recover the true UTC instant. Python builds the offset as
  //   diff = timedelta(hours=int(group2), minutes=int(group3))
  //   return base - diff
  // where group2 is the SIGNED hour component (e.g. -7) and group3 is the
  // (always positive) minute component, added independently. So for `-07:00`
  // the diff is -7h and `base - (-7h)` adds 7h; for a hypothetical `-07:30`
  // the diff is (-7h + 30m) = -6h30m and `base - diff` adds 6h30m.
  const base = buildUtcDate(naiveMatch);
  const signHours = Number(offsetMatch[2]); // signed, e.g. -7 or +5
  const minutes = Number(offsetMatch[3]); // always non-negative
  const diffMinutes = signHours * 60 + minutes; // matches timedelta(hours, minutes)
  return new Date(base.getTime() - diffMinutes * 60 * 1000);
}

/**
 * Parse a legacy Ubiquity `modified` timestamp formatted as
 * `%Y-%m-%dT%H:%M:%SZ` (always UTC). Returns `null` for falsy input.
 *
 * @param date The raw Ubiquity timestamp string, or null/undefined.
 * @returns A UTC `Date`, or `null` when the input is falsy.
 */
export function parseUbiquityDate(date: string | null | undefined): Date | null {
  if (!date) {
    return null;
  }
  const match = UTC_RE.exec(date);
  if (!match) {
    throw new RangeError(`Unparseable Ubiquity date: ${date}`);
  }
  return buildUtcDate(match);
}

/**
 * Build a UTC `Date` from a regex match whose groups 1..6 are
 * year, month, day, hour, minute, second.
 */
function buildUtcDate(match: RegExpExecArray): Date {
  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1, // JS months are 0-indexed
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ),
  );
}
