/**
 * The filter compiler's pure core, against a stub validator rather than the
 * authored catalog.
 *
 * That is the point of the split: the fragments, the parameter order and the
 * `(none)` expansion are the same whether the columns were approved by the
 * server's per-view allowlist or by an uploaded study's own column list, so they
 * are tested here without a catalog. The catalog's own rejections are tested in
 * `packages/server/src/sql/filters.test.ts`, which exercises this core through
 * `compileFilters`.
 */

import { describe, expect, it } from 'vitest';
import { asColumnId, type FieldKind, type Filter, type Selection } from '../types.js';
import {
  FilterError,
  MAX_IN_VALUES,
  compileFiltersCore,
  isIsoDateString,
  quoteIdent,
  quoteLiteral,
  type FilterValidator,
} from './filters-core.js';

const KINDS: Readonly<Record<string, FieldKind>> = {
  manufacturer: 'categorical',
  echo_time: 'numeric',
  created_at: 'date',
};

/** A validator that knows three columns and two metrics, and refuses anything else. */
const validator: FilterValidator = {
  field: (fieldId) => {
    const kind = KINDS[fieldId];
    if (kind === undefined) throw new FilterError(`no column "${fieldId}" in the study`);
    return { id: fieldId, kind };
  },
  metric: (metricId) => {
    if (!['fd_mean', 'efc'].includes(metricId)) throw new FilterError(`no metric "${metricId}" in the study`);
    return metricId;
  },
};

const field = (id: string) => asColumnId(id);
const compile = (filters: readonly Filter[], selection: readonly Selection[] | Selection | null = null) =>
  compileFiltersCore(filters, selection, validator);

describe('compileFiltersCore', () => {
  it('compiles zero, one and two ranges as a conjunction, after filter parameters', () => {
    const a: Selection = { metric: field('fd_mean'), range: [0, 1] };
    const b: Selection = { metric: field('efc'), range: [2, 3] };
    expect(compile([], [])).toEqual({ where: 'TRUE', params: [] });
    expect(compile([], [a])).toEqual(compile([], a));
    const result = compile([{ field: field('manufacturer'), op: 'in', values: ['GE'] }], [a, b]);
    expect(result.params).toEqual(['GE', 0, 1, 2, 3]);
    expect(result.where).toBe('TRUE AND ("manufacturer" IN (?))' +
      ' AND isfinite(CAST("fd_mean" AS DOUBLE)) AND CAST("fd_mean" AS DOUBLE) BETWEEN ? AND ?' +
      ' AND isfinite(CAST("efc" AS DOUBLE)) AND CAST("efc" AS DOUBLE) BETWEEN ? AND ?');
  });

  it('refuses duplicate metrics and more than four ranges before compiling', () => {
    const selection: Selection = { metric: field('fd_mean'), range: [0, 1] };
    expect(() => compile([], [selection, selection])).toThrow(/distinct/);
    expect(() => compile([], Array(5).fill(selection))).toThrow(/at most 4/);
  });
  it('compiles an empty filter list to TRUE with no parameters', () => {
    expect(compile([])).toEqual({ where: 'TRUE', params: [] });
  });

  it('starts every fragment with TRUE so it can be appended unconditionally', () => {
    const { where } = compile([{ field: field('manufacturer'), op: 'notNull' }]);
    expect(where).toBe('TRUE AND "manufacturer" IS NOT NULL');
  });

  it('binds one placeholder per in value, in order', () => {
    const { where, params } = compile([
      { field: field('manufacturer'), op: 'in', values: ['Siemens', 'GE'] },
    ]);
    expect(where).toBe('TRUE AND ("manufacturer" IN (?, ?))');
    expect(params).toEqual(['Siemens', 'GE']);
  });

  it('expands the (none) value to null-or-empty and binds nothing for it', () => {
    const { where, params } = compile([
      { field: field('manufacturer'), op: 'in', values: ['Siemens', '', 'GE'] },
    ]);
    expect(where).toBe(
      `TRUE AND ("manufacturer" IN (?, ?)` +
        ` OR "manufacturer" IS NULL OR CAST("manufacturer" AS VARCHAR) = '')`,
    );
    expect(params).toEqual(['Siemens', 'GE']);
  });

  it('casts a date range so ISO text compares as a timestamp', () => {
    const { where, params } = compile([
      { field: field('created_at'), op: 'between', lo: '2020-01-01', hi: '2021-01-01' },
    ]);
    expect(where).toBe(
      'TRUE AND "created_at" BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)',
    );
    expect(params).toEqual(['2020-01-01', '2021-01-01']);
  });

  it('compiles a numeric range to two bound parameters', () => {
    const { where, params } = compile([{ field: field('echo_time'), op: 'between', lo: 1, hi: 2 }]);
    expect(where).toBe('TRUE AND "echo_time" BETWEEN ? AND ?');
    expect(params).toEqual([1, 2]);
  });

  it('binds the filters in list order, then the selection', () => {
    const { where, params } = compile(
      [
        { field: field('manufacturer'), op: 'in', values: ['GE'] },
        { field: field('echo_time'), op: 'between', lo: 0.03, hi: 0.05 },
      ],
      { metric: field('fd_mean'), range: [0.1, 0.4] },
    );
    expect(where).toBe(
      'TRUE AND ("manufacturer" IN (?)) AND "echo_time" BETWEEN ? AND ?' +
        ' AND isfinite(CAST("fd_mean" AS DOUBLE))' +
        ' AND CAST("fd_mean" AS DOUBLE) BETWEEN ? AND ?',
    );
    expect(params).toEqual(['GE', 0.03, 0.05, 0.1, 0.4]);
  });

  it('guards the selection with isfinite, because a brush only ever drew finite values', () => {
    const { where } = compile([], { metric: field('fd_mean'), range: [0, 1] });
    expect(where).toContain('isfinite(CAST("fd_mean" AS DOUBLE))');
  });

  it.each([
    ['between on a categorical field', [{ field: field('manufacturer'), op: 'between', lo: 'A', hi: 'Z' }], /not allowed on categorical field/],
    ['in on a date field', [{ field: field('created_at'), op: 'in', values: ['2020-01-01'] }], /not allowed on date field/],
    ['an empty in list', [{ field: field('manufacturer'), op: 'in', values: [] }], /empty "in" list/],
    ['a non-finite numeric bound', [{ field: field('echo_time'), op: 'between', lo: Number.NaN, hi: 1 }], /two finite number bounds/],
    ['an inverted numeric range', [{ field: field('echo_time'), op: 'between', lo: 5, hi: 1 }], /lo greater than hi/],
    ['numeric bounds on a date field', [{ field: field('created_at'), op: 'between', lo: 0, hi: 1 }], /ISO-8601 string bounds/],
    ['a non-number in value on a numeric field', [{ field: field('echo_time'), op: 'in', values: ['x'] }], /needs finite number values/],
  ] as ReadonlyArray<readonly [string, Filter[], RegExp]>)('refuses %s', (_name, filters, message) => {
    expect(() => compile(filters)).toThrow(message);
  });

  it(`accepts exactly ${MAX_IN_VALUES} values and refuses one more`, () => {
    const values = Array.from({ length: MAX_IN_VALUES }, (_, i) => `v${i}`);
    expect(() => compile([{ field: field('manufacturer'), op: 'in', values }])).not.toThrow();
    expect(() =>
      compile([{ field: field('manufacturer'), op: 'in', values: [...values, 'one more'] }]),
    ).toThrow(/over the 500 limit/);
  });

  it('refuses an inverted selection range', () => {
    expect(() => compile([], { metric: field('fd_mean'), range: [1, 0] })).toThrow(
      /lo greater than hi/,
    );
  });

  it('lets the caller refuse a column it does not have, in the caller’s own words', () => {
    expect(() => compile([{ field: field('no_such_column'), op: 'isNull' }])).toThrow(
      /no column "no_such_column" in the study/,
    );
    expect(() => compile([], { metric: field('cjv'), range: [0, 1] })).toThrow(
      /no metric "cjv" in the study/,
    );
  });

  it('quotes identifiers and literals, doubling the embedded quote', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });

  it('accepts a date and a timestamp, and nothing else, as a date bound', () => {
    expect(isIsoDateString('2020-01-01')).toBe(true);
    expect(isIsoDateString('2020-01-01T12:00:00Z')).toBe(true);
    expect(isIsoDateString('not a date')).toBe(false);
    expect(isIsoDateString(0)).toBe(false);
  });
});
