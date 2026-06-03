import { underscoreToCamelcase } from '../src/util/camelcase';
import { dateToUtc, parseUbiquityDate } from '../src/util/date';
import { redactSecret, REDACTION } from '../src/util/redact';

describe('underscoreToCamelcase', () => {
  it('camelCases a simple underscore word', () => {
    expect(underscoreToCamelcase('foo_bar')).toBe('fooBar');
  });

  it('PascalCases when initialCapital is true', () => {
    expect(underscoreToCamelcase('foo_bar', true)).toBe('FooBar');
  });

  it('lower-cases the interior of each piece (Python str.capitalize semantics)', () => {
    // e.g. model_display_name -> modelDisplayName; mixed-case input is normalized.
    expect(underscoreToCamelcase('model_DISPLAY_name')).toBe('modelDisplayName');
    expect(underscoreToCamelcase('MODEL_display_NAME', true)).toBe('ModelDisplayName');
  });

  it('handles a single word', () => {
    expect(underscoreToCamelcase('device')).toBe('device');
    expect(underscoreToCamelcase('device', true)).toBe('Device');
  });

  it('represents empty pieces as a literal underscore (leading/doubled/trailing)', () => {
    // Python: [x.capitalize() or "_" for x in word.split("_")]
    expect(underscoreToCamelcase('_foo')).toBe('_Foo');
    expect(underscoreToCamelcase('foo__bar')).toBe('foo_Bar');
    expect(underscoreToCamelcase('foo_')).toBe('foo_');
  });
});

describe('dateToUtc', () => {
  it('returns null for falsy input', () => {
    expect(dateToUtc(undefined)).toBeNull();
    expect(dateToUtc(null)).toBeNull();
    expect(dateToUtc('')).toBeNull();
  });

  it('parses a Z-suffixed timestamp as UTC unchanged', () => {
    const d = dateToUtc('2021-04-15T12:34:56Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2021-04-15T12:34:56.000Z');
  });

  it('adds 7 hours for a -07:00 California (PDT) offset', () => {
    // Wall clock 05:00 at -07:00 is 12:00 UTC.
    const d = dateToUtc('2021-07-15T05:00:00-07:00');
    expect(d!.toISOString()).toBe('2021-07-15T12:00:00.000Z');
  });

  it('adds 8 hours for a -08:00 California (PST) offset', () => {
    // Wall clock 04:00 at -08:00 is 12:00 UTC.
    const d = dateToUtc('2021-01-15T04:00:00-08:00');
    expect(d!.toISOString()).toBe('2021-01-15T12:00:00.000Z');
  });

  it('rolls the date forward when subtracting a negative offset crosses midnight', () => {
    // 20:00 at -08:00 -> 04:00 next day UTC.
    const d = dateToUtc('2021-01-15T20:00:00-08:00');
    expect(d!.toISOString()).toBe('2021-01-16T04:00:00.000Z');
  });

  it('subtracts a positive offset (matches timedelta hours+minutes)', () => {
    // 18:30 at +05:30 -> 13:00 UTC.
    const d = dateToUtc('2021-06-01T18:30:00+05:30');
    expect(d!.toISOString()).toBe('2021-06-01T13:00:00.000Z');
  });

  it('throws on an unparseable string', () => {
    expect(() => dateToUtc('not-a-date')).toThrow(RangeError);
  });
});

describe('parseUbiquityDate', () => {
  it('returns null for falsy input', () => {
    expect(parseUbiquityDate(undefined)).toBeNull();
    expect(parseUbiquityDate('')).toBeNull();
  });

  it('parses %Y-%m-%dT%H:%M:%SZ as UTC', () => {
    const d = parseUbiquityDate('2019-12-31T23:59:59Z');
    expect(d!.toISOString()).toBe('2019-12-31T23:59:59.000Z');
  });

  it('throws on a non-Z timestamp', () => {
    expect(() => parseUbiquityDate('2019-12-31T23:59:59-07:00')).toThrow(RangeError);
  });
});

describe('redactSecret', () => {
  it('replaces every occurrence of the secret with eight asterisks', () => {
    expect(redactSecret('login with hunter2 / hunter2', 'hunter2')).toBe(
      `login with ${REDACTION} / ${REDACTION}`,
    );
  });

  it('leaves text untouched when the secret is absent', () => {
    expect(redactSecret('no secrets here', 'hunter2')).toBe('no secrets here');
  });

  it('ignores empty or missing secrets', () => {
    expect(redactSecret('unchanged', '')).toBe('unchanged');
    expect(redactSecret('unchanged', undefined)).toBe('unchanged');
  });
});
