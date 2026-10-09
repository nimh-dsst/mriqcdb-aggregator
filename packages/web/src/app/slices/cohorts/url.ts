/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import {
MAX_COHORT_ID_LENGTH,
MAX_COHORT_NAME,
textCodec,
unsigned
} from '../../codec/tokens';
import {
MAX_COHORTS
} from '../../graph/state';

import { currentView,list,record,viewCodec,type Context,type RecordValue,type Schema } from '../../codec/records';
import { filters,selections } from '../filters/url';
export const COHORT_FIELDS: Schema = [
  {
    field: 'id',
    codec: textCodec(MAX_COHORT_ID_LENGTH),
    default: (ctx: Context) => 'c' + (ctx.index + 1),
  },
  { field: 'name', codec: textCodec(MAX_COHORT_NAME), default: 'Cohort' },
  { field: 'color', codec: unsigned, default: (ctx: Context) => ctx.index + 2 },
  {
    field: 'source',
    required: true,
    codec: {
      write(_writer, value) {
        if (value !== 'population') throw new Error('Study rows cannot be shared');
      },
      read: () => 'population',
    },
    default: 'population',
  },
  { field: 'view', codec: viewCodec, default: currentView },
  { field: 'filters', codec: filters, default: [] },
  { field: 'selections', codec: selections, default: [] },
];
const cohortRecord = record(COHORT_FIELDS);
export const cohorts = list(
  {
    write: cohortRecord.write,
    read(reader, ctx) {
      const cohort = cohortRecord.read(reader, ctx);
      if (!cohort.id.length) throw new Error('Empty cohort id');
      if (cohort.selections.some((selection: RecordValue) => selection['from'] !== undefined))
        throw new Error('A saved selection has no source panel');
      return cohort;
    },
  },
  MAX_COHORTS,
);

