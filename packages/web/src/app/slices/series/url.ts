/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import {
dateCodec,
enumeration,
MAX_COHORT_NAME,
MAX_FILTER_VALUES,
roundedNumber,
textCodec
} from '../../codec/tokens';
import { MAX_BUCKETS } from './model';

import { fieldToken,list,metricToken,pair,record,reference,type Context,type Schema } from '../../codec/records';
import { filters,filterValue } from '../filters/url';
const BUCKET_FIELDS: Schema = [
  { field: 'name', codec: textCodec(MAX_COHORT_NAME), default: 'Group' },
  { field: 'filters', codec: filters, default: undefined },
  {
    field: 'selections',
    codec: list(record([
      { field: 'metric', codec: metricToken, default: 'fd_mean' },
      { field: 'range', codec: pair(roundedNumber), default: undefined },
    ]), 4),
    default: undefined,
  },
];

export const SERIES_FIELDS: Schema = [
  {
    field: 'kind',
    codec: enumeration(['field', 'values', 'population', 'cohort', 'study', 'span', 'buckets']),
    default: (ctx: Context) => ((ctx.root['cohorts'] as unknown[]).length ? 'cohort' : 'field'),
  },
  { field: 'field', codec: fieldToken, default: undefined },
  { field: 'values', codec: list(filterValue, MAX_FILTER_VALUES), default: undefined },
  {
    field: 'id',
    codec: reference('cohorts'),
    default: (ctx: Context) =>
      ctx.draft['kind'] === 'cohort'
        ? (ctx.root['cohorts'] as { id: string }[])[ctx.index]?.id
        : undefined,
  },
  { field: 'from', codec: dateCodec, default: undefined },
  { field: 'to', codec: dateCodec, default: undefined },
  // Appended last so links made before custom splits existed still decode.
  { field: 'buckets', codec: list(record(BUCKET_FIELDS), MAX_BUCKETS), default: undefined },
];
const seriesRecord = record(SERIES_FIELDS);
export const series = list(
  {
    write: seriesRecord.write,
    read(reader, ctx) {
      const value = seriesRecord.read(reader, ctx);
      const expected: Record<string, string[]> = {
        field: ['kind', 'field'],
        values: ['kind', 'field', 'values'],
        population: ['kind'],
        cohort: ['kind', 'id'],
        study: ['kind'],
        span: ['kind', 'from', 'to'],
        buckets: ['kind', 'buckets'],
      };
      const keys = expected[value.kind];
      if (
        !keys ||
        keys.length !== Object.keys(value).length ||
        !keys.every((key) => value[key] !== undefined)
      )
        throw new Error('Invalid series');
      if (
        value.kind === 'values' &&
        (!value.values.length || value.values.some((item: unknown) => typeof item !== 'string'))
      )
        throw new Error('Invalid selected values');
      if (value.kind === 'span' && value.from > value.to) throw new Error('Invalid date span');
      if (value.kind === 'buckets' && (!value.buckets.length || value.buckets.some((bucket: { filters?: unknown[]; selections?: unknown[] }) => !bucket.filters?.length && !bucket.selections?.length)))
        throw new Error('Invalid custom split');
      return value;
    },
  },
  6,
);

