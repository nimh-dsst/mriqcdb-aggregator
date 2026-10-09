/** Scalar codecs for the schema-positional, six-bit URL stream. */
import { MODALITIES, VIEWS, getAuthoredCatalog } from '@mriqc/shared';
import { FORM_ORDER } from '../forms/registry';
import { MAX_BINS, MIN_BINS, defaultPanelOptions } from './state';

export const URL_VERSION = '1';
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const MAX_PARAM_LENGTH = 4096;
export const MAX_PANELS = 50;
export const MAX_FILTER_VALUES = 500;
export const MAX_ID_LENGTH = 32;
export const MAX_COHORT_FILTERS = 50;
export const MAX_COHORT_NAME = 80;
export const MAX_COHORT_ID_LENGTH = 160;

/** Writes bits directly into URL characters; no byte/base64 layer. */
export class BitWriter {
  private readonly chars: string[] = [];
  private pending = 0;
  private used = 0;
  write(bits: number, value: number): void {
    if (
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > 53 ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= 2 ** bits
    )
      throw new Error('Invalid bit value');
    for (let bit = bits - 1; bit >= 0; bit--) {
      this.pending = this.pending * 2 + (Math.floor(value / 2 ** bit) % 2);
      if (++this.used === 6) {
        this.chars.push(ALPHABET[this.pending]);
        this.pending = 0;
        this.used = 0;
      }
    }
  }
  finish(): string {
    return [
      ...this.chars,
      ...(this.used ? [ALPHABET[this.pending * 2 ** (6 - this.used)]] : []),
    ].join('');
  }
}

/** Strict alphabet, bounds and padding checks make truncation fail closed. */
export class BitReader {
  private position = 0;
  constructor(private readonly text: string) {
    if (text.length > MAX_PARAM_LENGTH || !/^[A-Za-z0-9_-]*$/.test(text))
      throw new Error('Invalid stream');
  }
  read(bits: number): number {
    if (
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > 53 ||
      this.position + bits > this.text.length * 6
    )
      throw new Error('Truncated stream');
    let value = 0;
    for (let i = 0; i < bits; i++, this.position++) {
      const digit = ALPHABET.indexOf(this.text[Math.floor(this.position / 6)]);
      value = value * 2 + ((digit >> (5 - (this.position % 6))) & 1);
    }
    return value;
  }
  finish(): void {
    const remaining = this.text.length * 6 - this.position;
    if (remaining >= 6 || this.read(remaining) !== 0) throw new Error('Trailing stream data');
  }
}

export interface Codec<T = unknown> {
  write(writer: BitWriter, value: T): void;
  read(reader: BitReader): T;
}

export const unsigned: Codec<number> = {
  write(writer, value) {
    if (!Number.isInteger(value) || value < 0 || value > 4158)
      throw new Error('Integer outside stream range');
    writer.write(6, Math.min(value, 63));
    if (value >= 63) writer.write(12, value - 63);
  },
  read(reader) {
    const value = reader.read(6);
    return value === 63 ? 63 + reader.read(12) : value;
  },
};

export function fixed(bits: number): Codec<number> {
  return {
    write: (writer, value) => writer.write(bits, value),
    read: (reader) => reader.read(bits),
  };
}

export function enumeration<T>(values: readonly T[], bits = 6): Codec<T> {
  return {
    write(writer, value) {
      const index = values.indexOf(value);
      if (index < 0) throw new Error('Unknown enum value');
      writer.write(bits, index);
    },
    read(reader) {
      const index = reader.read(bits);
      if (index >= values.length) throw new Error('Unknown enum index');
      return values[index];
    },
  };
}

export interface TokenTable {
  readonly code: ReadonlyMap<string, string>;
  readonly id: ReadonlyMap<string, string>;
  readonly values: readonly string[];
}

/** Prefix-free catalog indices: 0..62 take one character, the rest take two. */
export function tokenTable(ids: readonly string[]): TokenTable {
  const values = [...new Set(ids)];
  if (values.length > 127) throw new Error('Catalog exceeds two-character token space');
  const code = new Map(
    values.map((id, index) => [
      id,
      index < 63 ? ALPHABET[index] : ALPHABET[63] + ALPHABET[index - 63],
    ]),
  );
  return { code, id: new Map([...code].map(([id, token]) => [token, id])), values };
}

export function tokenCodec(table: TokenTable): Codec<string> {
  return {
    write(writer, value) {
      const index = table.values.indexOf(value);
      if (index < 0) throw new Error('Unknown catalog id');
      writer.write(6, Math.min(index, 63));
      if (index >= 63) writer.write(6, index - 63);
    },
    read(reader) {
      const first = reader.read(6);
      const index = first === 63 ? 63 + reader.read(6) : first;
      if (index >= table.values.length) throw new Error('Unknown catalog token');
      return table.values[index];
    },
  };
}

const authored = getAuthoredCatalog();
export const METRIC_TOKENS = tokenTable(authored.metrics.map((metric) => String(metric.id)));
export const FIELD_TOKENS = tokenTable(authored.fields.map((field) => String(field.id)));
export const COLUMN_TOKENS = tokenTable([
  ...authored.metrics.map((metric) => String(metric.id)),
  ...authored.fields.map((field) => String(field.id)),
]);
export const MODALITY_TOKENS = tokenTable(MODALITIES);
export const VIEW_TOKENS = tokenTable(VIEWS);
// Pinned to the fixed form order, not to whichever axis shape lists a form
// first: a link's form character must not move when availability changes.
export const CHART_TOKENS = tokenTable(FORM_ORDER);
export const CLIP_TOKENS = tokenTable(['p01p99', 'p05p95', 'none']);
export const GRANULARITY_TOKENS = tokenTable(['day', 'week', 'month', 'year']);
export const OP_TOKENS = tokenTable(['in', 'between', 'isNull', 'notNull']);
export const SOURCE_TOKENS = tokenTable(['population', 'study']);
export const toToken = (table: TokenTable, value: string | null | undefined): string =>
  table.code.get(value ?? '') ?? '';
export const fromToken = (table: TokenTable, value: string): string | null =>
  table.id.get(value) ?? null;

/** Pinned vocabularies; never use server counts/order as a wire alphabet. */
const CATEGORIES: Readonly<Record<string, readonly (string | number | boolean)[]>> = {
  manufacturer: [
    'Siemens',
    'GE',
    'Philips',
    'Bruker',
    'Canon',
    'Hitachi',
    'Toshiba',
    'United Imaging',
    'Fujifilm',
    'Mediso',
    'Agilent',
    'Hyperfine',
    'Synthesized',
    'Medics',
    'Unknown',
  ],
  magnetic_field_strength: [1.5, 3, 7],
  ...Object.fromEntries(
    authored.fields.flatMap((field) => {
      const values = (field as unknown as { values?: readonly (string | number | boolean)[] })
        .values;
      return values ? [[field.id, values]] : [];
    }),
  ),
};
export const categoryValues = (field: string): readonly (string | number | boolean)[] =>
  CATEGORIES[field] ?? [];

/** Alphanumerics and space take six bits; other UTF-8 bytes are escaped. */
export function textCodec(limit = MAX_PARAM_LENGTH): Codec<string> {
  return {
    write(writer, value) {
      if (!isWellFormed(value) || value.length > limit) throw new Error('Invalid text');
      const bytes = new TextEncoder().encode(value);
      unsigned.write(writer, bytes.length);
      for (const byte of bytes) {
        const index = ALPHABET.indexOf(String.fromCharCode(byte));
        if (index >= 0 && index < 62) writer.write(6, index);
        else if (byte === 32) writer.write(6, 62);
        else {
          writer.write(6, 63);
          writer.write(8, byte);
        }
      }
    },
    read(reader) {
      const length = unsigned.read(reader);
      if (length > limit * 4) throw new Error('Text limit exceeded');
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const index = reader.read(6);
        bytes[i] = index === 63 ? reader.read(8) : index === 62 ? 32 : ALPHABET.charCodeAt(index);
      }
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (value.length > limit || !isWellFormed(value)) throw new Error('Invalid text');
      return value;
    },
  };
}

/** Exact decimal spellings: a length followed by packed decimal digits. */
export const exactNumber: Codec<number> = {
  write(writer, value) {
    if (!Number.isFinite(value)) throw new Error('Nonfinite number');
    const text = Object.is(value, -0) ? '-0' : String(value);
    writer.write(6, text.length);
    for (const char of text) writer.write(4, '0123456789.-e+'.indexOf(char));
  },
  read(reader) {
    const length = reader.read(6);
    if (length < 1 || length > 25) throw new Error('Invalid decimal length');
    const chars: string[] = [];
    for (let i = 0; i < length; i++) {
      const char = '0123456789.-e+'[reader.read(4)];
      if (char === undefined) throw new Error('Invalid decimal digit');
      chars.push(char);
    }
    const text = chars.join('');
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/.test(text))
      throw new Error('Invalid decimal');
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error('Nonfinite decimal');
    return value;
  },
};

/** Sign, three significant digits and exponent: three or four URL characters. */
export const roundedNumber: Codec<number> = {
  write(writer, value) {
    if (!Number.isFinite(value)) throw new Error('Nonfinite range');
    const [coefficient, exponentText] = Math.abs(value).toExponential(2).split('e');
    const exponent = Number(exponentText);
    // Rounding MAX_VALUE upward would turn a finite range into Infinity.
    const mantissa = Math.min(Math.round(Number(coefficient) * 100), exponent === 308 ? 179 : 999);
    const wide = exponent < -31 || exponent > 32;
    writer.write(1, value < 0 ? 1 : 0);
    writer.write(10, mantissa);
    writer.write(1, wide ? 1 : 0);
    writer.write(wide ? 12 : 6, exponent + (wide ? 324 : 31));
  },
  read(reader) {
    const negative = reader.read(1) !== 0;
    const mantissa = reader.read(10);
    const wide = reader.read(1) !== 0;
    const exponent = reader.read(wide ? 12 : 6) - (wide ? 324 : 31);
    if (mantissa > 999 || (mantissa > 0 && mantissa < 100) || exponent < -324 || exponent > 308)
      throw new Error('Invalid range number');
    const value = Number([negative ? '-' : '', mantissa, 'e', exponent - 2].join(''));
    if (!Number.isFinite(value)) throw new Error('Range overflow');
    return value;
  },
};

const EPOCH = Date.UTC(2000, 0, 1);
export const dateCodec: Codec<string> = {
  write(writer, value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
      throw new Error('Invalid date');
    writer.write(18, (time - EPOCH) / 86400000 + 131072);
  },
  read(reader) {
    return new Date(EPOCH + (reader.read(18) - 131072) * 86400000).toISOString().slice(0, 10);
  },
};

export function clampBins(bins: unknown): number {
  const n = Math.round(Number(bins));
  return Number.isFinite(n)
    ? Math.min(MAX_BINS, Math.max(MIN_BINS, n))
    : defaultPanelOptions().bins;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const isWellFormed = (value: string): boolean => !LONE_SURROGATE.test(value);

export function uniqueIds<T extends { id: string }>(
  items: readonly T[],
  prefix: 'p' | 'c' = 'p',
): readonly T[] {
  const taken = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  let candidate = 1;
  return items.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    while (seen.has(prefix + candidate) || taken.has(prefix + candidate)) candidate++;
    const id = prefix + candidate;
    seen.add(id);
    return { ...item, id };
  });
}

export function normalizeSelection<T extends { range: [number, number] }>(selection: T): T | null {
  const [lo, hi] = selection.range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? selection : { ...selection, range: [hi, lo] };
}
