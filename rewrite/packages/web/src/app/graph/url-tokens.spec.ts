import {
  ALPHABET,
  CHART_TOKENS,
  BitReader,
  BitWriter,
  dateCodec,
  exactNumber,
  roundedNumber,
  unsigned,
  textCodec,
  tokenCodec,
  tokenTable,
  type Codec,
} from './url-tokens';
import { formsFor } from './panel-shapes';
import { asColumnId } from '@mriqc/shared';

function roundTrip<T>(codec: Codec<T>, value: T): T {
  const writer = new BitWriter();
  codec.write(writer, value);
  const reader = new BitReader(writer.finish());
  const decoded = codec.read(reader);
  reader.finish();
  return decoded;
}

describe('six-bit URL scalars', () => {
  it('assigns one character per canonical form in formsFor order', () => {
    expect(CHART_TOKENS.values).toEqual(['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table', 'band',
      'heatmap', 'scatter', 'hexbin', 'clusters', 'bars', 'share', 'matrix']);
    const metric = asColumnId('snr');
    const forms = [...new Set([
      ...formsFor(metric, 'count'), ...formsFor('created_at', 'count'),
      ...formsFor('created_at', metric), ...formsFor(metric, asColumnId('fd_mean')),
      ...formsFor(asColumnId('manufacturer'), 'count'), ...formsFor([], 'count'),
    ])];
    expect(CHART_TOKENS.values).toEqual(forms);
    forms.forEach((form, index) => {
      expect(CHART_TOKENS.code.get(form)).toBe(ALPHABET[index]);
      expect(roundTrip(tokenCodec(CHART_TOKENS), form)).toBe(form);
    });
  });
  it('round-trips random mixed bit widths, including character boundaries', () => {
    let seed = 193781;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let run = 0; run < 1000; run++) {
      const values = Array.from({ length: 1 + (random() % 30) }, () => {
        const bits = random() % 33;
        return { bits, value: random() % 2 ** bits };
      });
      const writer = new BitWriter();
      values.forEach(({ bits, value }) => writer.write(bits, value));
      const reader = new BitReader(writer.finish());
      values.forEach(({ bits, value }) => expect(reader.read(bits)).toBe(value));
      reader.finish();
    }
  });

  it('rejects invalid widths, overflows, truncation and nonzero padding', () => {
    const writer = new BitWriter();
    expect(() => writer.write(6, 64)).toThrow();
    expect(() => writer.write(1, -1)).toThrow();
    expect(() => writer.write(1.5, 0)).toThrow();
    expect(() => new BitReader('A').read(7)).toThrow();
    expect(() => new BitReader('%')).toThrow();
    const reader = new BitReader('B');
    reader.read(1);
    expect(() => reader.finish()).toThrow();
    expect(() => new BitReader('A').finish()).toThrow();
  });

  it.each([0, 1, 62, 63, 64, 200, 4158])(
    'round-trips integer %s across the escape boundary',
    (value) => {
      expect(roundTrip(unsigned, value)).toBe(value);
    },
  );

  it.each([
    0,
    -0,
    -1.25e-7,
    0.012345678901234567,
    20200101,
    1e21,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
  ])('preserves exact decimal %s', (value) => {
    expect(Object.is(roundTrip(exactNumber, value), value)).toBe(true);
  });

  it.each([0, 0.1, -0.1234567, 9.9999, 1e-100, 1.23456e100, Number.MIN_VALUE])(
    'writes range %s at three significant digits in three or four characters',
    (value) => {
      expect(roundTrip(roundedNumber, value)).toBe(Number(value.toPrecision(3)));
      const writer = new BitWriter();
      roundedNumber.write(writer, value);
      expect([3, 4]).toContain(writer.finish().length);
    },
  );

  it.each(['1999-12-31', '2000-01-01', '2024-02-29', '2099-12-31'])(
    'round-trips day %s in three characters',
    (value) => {
      expect(roundTrip(dateCodec, value)).toBe(value);
      const writer = new BitWriter();
      dateCodec.write(writer, value);
      expect(writer.finish()).toHaveLength(3);
    },
  );

  it('keeps the largest finite range bounds finite at three digits', () => {
    expect(roundTrip(roundedNumber, Number.MAX_VALUE)).toBe(1.79e308);
    expect(roundTrip(roundedNumber, -Number.MAX_VALUE)).toBe(-1.79e308);
  });

  it('refuses an impossible date rather than moving it into the next month', () => {
    expect(() => roundTrip(dateCodec, '2023-02-29')).toThrow();
  });

  it.each(['', 'Siemens cohort', 'Hôpital Béclère 🧠', 'a;b,c:d|e~f!g#h?i%j%3Bk_^', '\u0000\r\n'])(
    'round-trips arbitrary text %j in the URL alphabet',
    (value) => {
      expect(roundTrip(textCodec(), value)).toBe(value);
      const writer = new BitWriter();
      textCodec().write(writer, value);
      expect([...writer.finish()].every((char) => ALPHABET.includes(char))).toBe(true);
    },
  );

  it('rejects unpaired surrogates', () => {
    expect(() => roundTrip(textCodec(), '\ud800')).toThrow();
  });

  it('keeps one- and two-character catalog tokens prefix-free in a stream', () => {
    const table = tokenTable(Array.from({ length: 127 }, (_, i) => String(i)));
    const codec = tokenCodec(table);
    const writer = new BitWriter();
    for (const value of table.values) codec.write(writer, value);
    const reader = new BitReader(writer.finish());
    for (const value of table.values) expect(codec.read(reader)).toBe(value);
    reader.finish();
    expect(table.code.get('62')).toHaveLength(1);
    expect(table.code.get('63')).toHaveLength(2);
  });
});
