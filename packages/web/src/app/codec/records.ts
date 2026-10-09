/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import { canonicalViewFor,viewsFor,type Modality } from '@mriqc/shared';
import {
BitReader,
BitWriter,
COLUMN_TOKENS,
enumeration,
FIELD_TOKENS,
MAX_COHORT_ID_LENGTH,
METRIC_TOKENS,
textCodec,
tokenCodec,
unsigned,
VIEW_TOKENS
} from './tokens';

export type RecordValue = Record<string, unknown>;
export interface Context {
  index: number;
  draft: RecordValue;
  root: RecordValue;
  baseline?: RecordValue;
}
export interface ContextCodec {
  write(writer: BitWriter, value: any, ctx: Context): void;
  read(reader: BitReader, ctx: Context): any;
}
export interface SchemaField {
  field: string;
  codec: ContextCodec;
  default: unknown | ((ctx: Context) => unknown);
  /** Implied constants have no optional presence slot. */
  required?: boolean;
}
export type Schema = readonly SchemaField[];

export function fallback(field: SchemaField, ctx: Context): unknown {
  return typeof field.default === 'function' ? field.default(ctx) : field.default;
}

/** Structural equality, independent of object insertion order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as RecordValue,
    right = b as RecordValue;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

export function writeRecord(
  writer: BitWriter,
  schema: Schema,
  source: RecordValue,
  context: Context,
): void {
  const ctx = { ...context, draft: source };
  const optional = schema.filter((field) => !field.required);
  const present = optional.map(
    (field) =>
      source[field.field] !== undefined && !sameValue(source[field.field], fallback(field, ctx)),
  );
  for (let start = 0; start < optional.length; start += 6) {
    let mask = 0;
    for (let bit = 0; bit < 6; bit++) if (present[start + bit]) mask |= 1 << bit;
    writer.write(6, mask);
  }
  let slot = 0;
  for (const field of schema) {
    if (field.required || present[slot++])
      field.codec.write(writer, source[field.field] ?? fallback(field, ctx), ctx);
  }
}

export function readRecord(reader: BitReader, schema: Schema, context: Context): RecordValue {
  const optionalCount = schema.filter((field) => !field.required).length;
  const masks: number[] = [];
  for (let start = 0; start < optionalCount; start += 6) masks.push(reader.read(6));
  const remainder = optionalCount % 6;
  if (remainder && masks[masks.length - 1] >= 2 ** remainder)
    throw new Error('Unknown record field');
  const draft: RecordValue = {};
  const ctx = { ...context, draft };
  let slot = 0;
  for (const field of schema) {
    const present = field.required || (masks[Math.floor(slot / 6)] & (1 << (slot % 6))) !== 0;
    if (!field.required) slot++;
    const value = present ? field.codec.read(reader, ctx) : fallback(field, ctx);
    if (value !== undefined) draft[field.field] = value;
  }
  return draft;
}

export function record(schema: Schema): ContextCodec {
  return {
    write: (writer, value, ctx) => writeRecord(writer, schema, value, ctx),
    read: (reader, ctx) => readRecord(reader, schema, ctx),
  };
}
export function list(codec: ContextCodec, limit: number): ContextCodec {
  return {
    write(writer, value: readonly unknown[], ctx) {
      if (!Array.isArray(value) || value.length > limit) throw new Error('List limit exceeded');
      unsigned.write(writer, value.length);
      value.forEach((item, index) => codec.write(writer, item, { ...ctx, index }));
    },
    read(reader, ctx) {
      const length = unsigned.read(reader);
      if (length > limit) throw new Error('List limit exceeded');
      return Array.from({ length }, (_, index) => codec.read(reader, { ...ctx, index }));
    },
  };
}
export function pair(codec: ContextCodec): ContextCodec {
  return {
    write(writer, value: readonly unknown[], ctx) {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid pair');
      value.forEach((item) => codec.write(writer, item, ctx));
    },
    read: (reader, ctx) => [codec.read(reader, ctx), codec.read(reader, ctx)],
  };
}
export const bool = enumeration([false, true], 1);
export const fieldToken = tokenCodec(FIELD_TOKENS);
export const metricToken = tokenCodec(METRIC_TOKENS);
export const columnToken = tokenCodec(COLUMN_TOKENS);
export const shortText = textCodec(MAX_COHORT_ID_LENGTH);
export const modality = (ctx: Context) => (ctx.root['modality'] ?? 'bold') as Modality;
export const viewCodec: ContextCodec = {
  write: (writer, value) => tokenCodec(VIEW_TOKENS).write(writer, value),
  read(reader, ctx) {
    const view = tokenCodec(VIEW_TOKENS).read(reader);
    return viewsFor(modality(ctx)).some((item) => item.id === view)
      ? view
      : canonicalViewFor(modality(ctx));
  },
};
export const currentView = (ctx: Context) => canonicalViewFor(modality(ctx));

/** References to known IDs use positional indices, custom IDs retain their text. */
export function reference(kind: 'panels' | 'cohorts'): ContextCodec {
  return {
    write(writer, value, ctx) {
      const items = (ctx.root[kind] ?? []) as { id: string }[];
      const index = items.findIndex((item) => item.id === value);
      if (index >= 0 && index < 62) writer.write(6, index);
      else {
        writer.write(6, 63);
        shortText.write(writer, value);
      }
    },
    read(reader, ctx) {
      const index = reader.read(6);
      if (index === 63) return shortText.read(reader);
      const item = ((ctx.root[kind] ?? []) as { id: string }[])[index];
      if (!item) throw new Error('Unknown reference');
      return item.id;
    },
  };
}
