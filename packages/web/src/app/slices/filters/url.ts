/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import {
  categoryValues,
  dateCodec,
  exactNumber,
  MAX_COHORT_FILTERS,
  MAX_FILTER_VALUES,
  OP_TOKENS,
  roundedNumber,
  textCodec,
  tokenCodec,
} from '../../codec/tokens';
import { OPEN_HI, OPEN_LO } from './model';

import {
  fieldToken,
  list,
  metricToken,
  pair,
  record,
  reference,
  type ContextCodec,
  type RecordValue,
  type Schema,
} from '../../codec/records';
/** Category index, typed exact decimal, date, open bound, or escaped text. */
export const filterValue: ContextCodec = {
  write(writer, value: string | number | boolean, ctx) {
    const values = categoryValues(String(ctx.draft['field']));
    const index = values.indexOf(value);
    if (index >= 0 && index < 56) {
      writer.write(6, index);
      return;
    }
    if (value === OPEN_LO) {
      writer.write(6, 61);
      return;
    }
    if (value === OPEN_HI) {
      writer.write(6, 62);
      return;
    }
    if (typeof value === 'boolean') {
      writer.write(6, value ? 59 : 58);
      return;
    }
    if (typeof value === 'number') {
      writer.write(6, 56);
      exactNumber.write(writer, value);
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      writer.write(6, 60);
      dateCodec.write(writer, value);
      return;
    }
    writer.write(6, 57);
    textCodec().write(writer, value);
  },
  read(reader, ctx) {
    const tag = reader.read(6);
    if (tag < 56) {
      const value = categoryValues(String(ctx.draft['field']))[tag];
      if (value === undefined) throw new Error('Unknown categorical index');
      return value;
    }
    switch (tag) {
      case 56:
        return exactNumber.read(reader);
      case 57:
        return textCodec().read(reader);
      case 58:
        return false;
      case 59:
        return true;
      case 60:
        return dateCodec.read(reader);
      case 61:
        return OPEN_LO;
      case 62:
        return OPEN_HI;
      default:
        throw new Error('Unknown scalar tag');
    }
  },
};
export const FILTER_FIELDS: Schema = [
  { field: 'field', codec: fieldToken, default: 'manufacturer' },
  { field: 'op', codec: tokenCodec(OP_TOKENS), default: 'in' },
  { field: 'values', codec: list(filterValue, MAX_FILTER_VALUES), default: undefined },
  { field: 'lo', codec: filterValue, default: undefined },
  { field: 'hi', codec: filterValue, default: undefined },
];
const filterRecord = record(FILTER_FIELDS);
export const filters: ContextCodec = list(
  {
    write: filterRecord.write,
    read(reader, ctx) {
      const value = filterRecord.read(reader, ctx) as RecordValue;
      if (value['op'] === 'in') {
        if (
          !Array.isArray(value['values']) ||
          !value['values'].length ||
          value['lo'] !== undefined ||
          value['hi'] !== undefined
        )
          throw new Error('Invalid in filter');
      } else if (value['op'] === 'between') {
        if (
          !['number', 'string'].includes(typeof value['lo']) ||
          !['number', 'string'].includes(typeof value['hi']) ||
          value['values'] !== undefined
        )
          throw new Error('Invalid between filter');
      } else if (
        value['values'] !== undefined ||
        value['lo'] !== undefined ||
        value['hi'] !== undefined
      )
        throw new Error('Invalid null filter');
      return value;
    },
  },
  MAX_COHORT_FILTERS,
);

export const SELECTION_FIELDS: Schema = [
  { field: 'from', codec: reference('panels'), default: undefined },
  { field: 'metric', codec: metricToken, default: 'fd_mean' },
  { field: 'range', codec: pair(roundedNumber), default: undefined },
];
const selectionRecord = record(SELECTION_FIELDS);
export const selections = list(
  {
    write: selectionRecord.write,
    read(reader, ctx) {
      const value = selectionRecord.read(reader, ctx);
      if (!Array.isArray(value.range)) throw new Error('Missing selection range');
      value.range.sort((a: number, b: number) => a - b);
      return value;
    },
  },
  4,
);

