/**
 * The filter compiler is pure, so it is tested exhaustively: every operator
 * against every field kind, every rejection the design names, and the exact
 * parameter order each fragment binds.
 */

import { describe, expect, it } from 'vitest';
import type { Filter, FieldDef, Modality, Selection, View } from '@mriqc/shared';
import { asColumnId, getAuthoredCatalog } from '@mriqc/shared';
import { MAX_IN_VALUES, compileFilters, quoteIdent } from './filters.js';

const catalog = getAuthoredCatalog();
const compile = (
  filters: readonly Filter[],
  selection: Selection | null = null,
  modality: Modality = 'bold',
  view: View = 'raw',
) => compileFilters(filters, selection, modality, view, catalog);

const field = (id: string): ColumnIdLike => asColumnId(id);
type ColumnIdLike = ReturnType<typeof asColumnId>;

/** One filterable field of each kind, taken from the authored catalog itself. */
const CATEGORICAL = 'manufacturer';
const NUMERIC = 'echo_time';
const DATE = 'created_at';

function kindOf(id: string): FieldDef['kind'] {
  return (catalog.fields.find((f) => f.id === id) as FieldDef).kind;
}

describe('compileFilters', () => {
  it('compiles an empty filter list to TRUE with no parameters', () => {
    expect(compile([])).toEqual({ where: 'TRUE', params: [] });
  });

  it('starts every fragment with TRUE so it can be appended unconditionally', () => {
    const { where } = compile([{ field: field(CATEGORICAL), op: 'notNull' }]);
    expect(where.startsWith('TRUE AND ')).toBe(true);
  });

  it('quotes identifiers and doubles an embedded quote', () => {
    expect(quoteIdent('manufacturer')).toBe('"manufacturer"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  describe('in', () => {
    it('binds one placeholder per value, in order', () => {
      const { where, params } = compile([
        { field: field(CATEGORICAL), op: 'in', values: ['Siemens', 'GE'] },
      ]);
      expect(where).toBe('TRUE AND ("manufacturer" IN (?, ?))');
      expect(params).toEqual(['Siemens', 'GE']);
    });

    it('expands the (none) value to null-or-empty', () => {
      // The completed catalog merges NULL and '' into one `(none)` option, so the
      // filter that picks it has to match both. The cast keeps the `= ''` arm safe
      // on a column DuckDB does not store as VARCHAR.
      const { where, params } = compile([{ field: field(CATEGORICAL), op: 'in', values: [''] }]);
      expect(where).toBe(
        `TRUE AND ("manufacturer" IS NULL OR CAST("manufacturer" AS VARCHAR) = '')`,
      );
      expect(params).toEqual([]);
    });

    it('ors (none) together with the named values picked beside it', () => {
      const { where, params } = compile([
        { field: field(CATEGORICAL), op: 'in', values: ['Siemens', '', 'GE'] },
      ]);
      expect(where).toBe(
        `TRUE AND ("manufacturer" IN (?, ?)` +
          ` OR "manufacturer" IS NULL OR CAST("manufacturer" AS VARCHAR) = '')`,
      );
      expect(params).toEqual(['Siemens', 'GE']);
    });

    it('accepts (none) on a numeric field without demanding a number', () => {
      const { where, params } = compile([{ field: field(NUMERIC), op: 'in', values: [0.03, ''] }]);
      expect(where).toBe(
        `TRUE AND ("echo_time" IN (?) OR "echo_time" IS NULL OR CAST("echo_time" AS VARCHAR) = '')`,
      );
      expect(params).toEqual([0.03]);
    });

    it('accepts numbers and booleans as values', () => {
      const { params } = compile([{ field: field(NUMERIC), op: 'in', values: [0.03, 0.05] }]);
      expect(params).toEqual([0.03, 0.05]);
    });

    it(`accepts exactly ${MAX_IN_VALUES} values`, () => {
      const values = Array.from({ length: MAX_IN_VALUES }, (_, i) => `v${i}`);
      expect(() => compile([{ field: field(CATEGORICAL), op: 'in', values }])).not.toThrow();
    });

    it(`rejects ${MAX_IN_VALUES + 1} values`, () => {
      const values = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `v${i}`);
      expect(() => compile([{ field: field(CATEGORICAL), op: 'in', values }])).toThrow(
        /over the 500 limit/,
      );
    });

    it('rejects an empty value list', () => {
      expect(() => compile([{ field: field(CATEGORICAL), op: 'in', values: [] }])).toThrow(
        /empty "in" list/,
      );
    });
  });

  describe('between', () => {
    it('compiles a numeric range to two bound parameters', () => {
      const { where, params } = compile([{ field: field(NUMERIC), op: 'between', lo: 1, hi: 2 }]);
      expect(where).toBe('TRUE AND "echo_time" BETWEEN ? AND ?');
      expect(params).toEqual([1, 2]);
    });

    it('casts a date range so ISO text compares as a timestamp', () => {
      const { where, params } = compile([
        { field: field(DATE), op: 'between', lo: '2020-01-01', hi: '2021-01-01' },
      ]);
      expect(where).toBe(
        'TRUE AND "created_at" BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)',
      );
      expect(params).toEqual(['2020-01-01', '2021-01-01']);
    });

    it('rejects between on a categorical field', () => {
      expect(kindOf(CATEGORICAL)).toBe('categorical');
      expect(() =>
        compile([{ field: field(CATEGORICAL), op: 'between', lo: 'A', hi: 'Z' }]),
      ).toThrow(/not allowed on categorical field/);
    });

    it('rejects non-numeric bounds on a numeric field', () => {
      expect(() => compile([{ field: field(NUMERIC), op: 'between', lo: 'a', hi: 'b' }])).toThrow(
        /two finite number bounds/,
      );
    });

    it('rejects a non-finite numeric bound', () => {
      expect(() =>
        compile([{ field: field(NUMERIC), op: 'between', lo: Number.NaN, hi: 1 }]),
      ).toThrow(/two finite number bounds/);
    });

    it('rejects an inverted range', () => {
      expect(() => compile([{ field: field(NUMERIC), op: 'between', lo: 5, hi: 1 }])).toThrow(
        /lo greater than hi/,
      );
    });

    it('rejects numeric bounds on a date field', () => {
      expect(() => compile([{ field: field(DATE), op: 'between', lo: 0, hi: 1 }])).toThrow(
        /ISO-8601 string bounds/,
      );
    });

    it.each([
      ['canonical_diameter', 'bold', 'k4plus'],
      ['canonical_diameter', 'T1w', 'k3pp'],
      ['canonical_group_rows', 'bold', 'k4plus'],
      ['canonical_group_rows', 'T2w', 'k3pp'],
    ] as const)('accepts a range on %s in %s/%s', (id, modality, view) => {
      expect(kindOf(id)).toBe('numeric');
      const { where, params } = compile(
        [{ field: field(id), op: 'between', lo: 0, hi: 0.01 }],
        null,
        modality,
        view,
      );
      expect(where).toBe(`TRUE AND ${quoteIdent(id)} BETWEEN ? AND ?`);
      expect(params).toEqual([0, 0.01]);
    });

    it('refuses a canonical-only range on the raw log', () => {
      expect(() =>
        compile([{ field: field('canonical_diameter'), op: 'between', lo: 0, hi: 1 }], null, 'bold', 'raw'),
      ).toThrow(/does not exist in the raw view/);
    });

    it('accepts the wide open end a one-sided range control sends', () => {
      const open = -(2 ** 52) + 0.5;
      const { params } = compile([
        { field: field('canonical_diameter'), op: 'between', lo: open, hi: 0.01 },
      ], null, 'bold', 'k4plus');
      expect(params).toEqual([open, 0.01]);
    });
  });

  describe('nullity', () => {
    it.each([
      ['isNull', 'IS NULL'],
      ['notNull', 'IS NOT NULL'],
    ] as const)('compiles %s with no parameters', (op, sql) => {
      const { where, params } = compile([{ field: field(CATEGORICAL), op }]);
      expect(where).toBe(`TRUE AND "manufacturer" ${sql}`);
      expect(params).toEqual([]);
    });

    it('allows nullity on every field kind', () => {
      for (const id of [CATEGORICAL, NUMERIC, DATE]) {
        expect(() => compile([{ field: field(id), op: 'isNull' }])).not.toThrow();
        expect(() => compile([{ field: field(id), op: 'notNull' }])).not.toThrow();
      }
    });
  });

  describe('operators allowed per field kind', () => {
    const ops: readonly Filter['op'][] = ['in', 'between', 'isNull', 'notNull'];
    const allowed: Readonly<Record<FieldDef['kind'], readonly Filter['op'][]>> = {
      categorical: ['in', 'isNull', 'notNull'],
      numeric: ['in', 'between', 'isNull', 'notNull'],
      date: ['between', 'isNull', 'notNull'],
    };

    const sample = (op: Filter['op'], id: string, kind: FieldDef['kind']): Filter => {
      if (op === 'in') return { field: field(id), op, values: kind === 'numeric' ? [1] : ['x'] };
      if (op === 'between') {
        return kind === 'date'
          ? { field: field(id), op, lo: '2020-01-01', hi: '2021-01-01' }
          : { field: field(id), op, lo: 0, hi: 1 };
      }
      return { field: field(id), op };
    };

    for (const id of [CATEGORICAL, NUMERIC, DATE]) {
      for (const op of ops) {
        const kind = kindOf(id);
        const ok = allowed[kind].includes(op);
        it(`${ok ? 'accepts' : 'rejects'} ${op} on the ${kind} field ${id}`, () => {
          const run = () => compile([sample(op, id, kind)]);
          if (ok) expect(run).not.toThrow();
          else expect(run).toThrow(/is not allowed on/);
        });
      }
    }
  });

  describe('field validity', () => {
    it('rejects a field the catalog does not know', () => {
      expect(() => compile([{ field: field('no_such_column'), op: 'isNull' }])).toThrow(
        /unknown filter field/,
      );
    });

    it('rejects a field that exists for another modality only', () => {
      // `task_id` is bold-only.
      expect(() => compile([{ field: field('task_id'), op: 'isNull' }], null, 'T1w', 'raw')).toThrow(
        /does not exist for modality T1w/,
      );
    });

    it('rejects a field that exists in another view only', () => {
      // `canonical_hmc_mode` is on the canonical bold table only.
      expect(() =>
        compile([{ field: field('canonical_hmc_mode'), op: 'isNull' }], null, 'bold', 'raw'),
      ).toThrow(/does not exist in the raw view/);
      expect(() =>
        compile([{ field: field('canonical_hmc_mode'), op: 'isNull' }], null, 'bold', 'k4plus'),
      ).not.toThrow();
    });

    it('rejects a column the catalog has but does not mark filterable', () => {
      // `id` is exportable, never filterable.
      expect(() => compile([{ field: field('id'), op: 'isNull' }])).toThrow(/is not filterable/);
    });

    it('rejects a metric used as a filter field', () => {
      expect(() => compile([{ field: field('fd_mean'), op: 'isNull' }])).toThrow(
        /unknown filter field/,
      );
    });
  });

  describe('selection', () => {
    it('adds isfinite alongside the range', () => {
      const { where, params } = compile([], {
        metric: field('fd_mean'),
        range: [0.1, 0.9],
      });
      expect(where).toBe(
        'TRUE AND isfinite(CAST("fd_mean" AS DOUBLE)) AND CAST("fd_mean" AS DOUBLE) BETWEEN ? AND ?',
      );
      expect(params).toEqual([0.1, 0.9]);
    });

    it('binds filter parameters before the selection parameters', () => {
      const { params } = compile(
        [{ field: field(CATEGORICAL), op: 'in', values: ['Siemens'] }],
        { metric: field('fd_mean'), range: [0, 1] },
      );
      expect(params).toEqual(['Siemens', 0, 1]);
    });

    it('rejects a metric the modality does not have', () => {
      expect(() => compile([], { metric: field('fd_mean'), range: [0, 1] }, 'T1w', 'raw')).toThrow(
        /unknown selection metric/,
      );
    });

    it('rejects a non-finite or inverted range', () => {
      expect(() =>
        compile([], { metric: field('fd_mean'), range: [Number.NEGATIVE_INFINITY, 1] }),
      ).toThrow(/finite range/);
      expect(() => compile([], { metric: field('fd_mean'), range: [2, 1] })).toThrow(
        /lo greater than hi/,
      );
    });

    it('is a no-op when null', () => {
      expect(compile([], null)).toEqual({ where: 'TRUE', params: [] });
    });
  });

  describe('value typing', () => {
    it('refuses a non-number in an `in` list on a numeric field', () => {
      expect(() =>
        compile([{ field: field(NUMERIC), op: 'in', values: ['0.03'] }]),
      ).toThrow(/finite number values/);
      expect(() =>
        compile([{ field: field(NUMERIC), op: 'in', values: [0.03, Number.NaN] }]),
      ).toThrow(/finite number values/);
    });

    it('accepts numbers in an `in` list on a numeric field', () => {
      const { where, params } = compile([{ field: field(NUMERIC), op: 'in', values: [0.03, 0.04] }]);
      expect(where).toBe('TRUE AND ("echo_time" IN (?, ?))');
      expect(params).toEqual([0.03, 0.04]);
    });

    it.each([
      ['a plain word', 'yesterday'],
      ['a US date', '01/02/2020'],
      ['a number', 20200101],
      ['a nearly-ISO string', '2020-1-1'],
    ])('refuses %s as a date bound', (_name, lo) => {
      expect(() =>
        compile([{ field: field(DATE), op: 'between', lo: lo as string, hi: '2021-01-01' }]),
      ).toThrow(/ISO-8601/);
    });

    it.each([
      ['a calendar date', '2020-01-01'],
      ['a UTC timestamp', '2020-01-01T00:00:00.000Z'],
      ['an offset timestamp', '2020-01-01T00:00:00+02:00'],
      ['a space-separated timestamp', '2020-01-01 12:30:00'],
    ])('accepts %s as a date bound', (_name, lo) => {
      const { params } = compile([
        { field: field(DATE), op: 'between', lo, hi: '2021-01-01T00:00:00.000Z' },
      ]);
      expect(params[0]).toBe(lo);
    });

    it('leaves a categorical value alone, since the catalog does not know its DuckDB type', () => {
      // `magnetic_field_strength` is a DOUBLE column served as a value list, so a
      // numeric value here is correct and a string one is the client's own problem,
      // caught as a conversion error and answered with BAD_REQUEST.
      const { params } = compile([
        { field: field('magnetic_field_strength'), op: 'in', values: [3, '7', true] },
      ]);
      expect(params).toEqual([3, '7', true]);
    });
  });

  describe('selection metrics listed twice in the catalog', () => {
    const DUPLICATED = [
      'summary_bg_k',
      'summary_bg_mad',
      'summary_bg_mean',
      'summary_bg_median',
      'summary_bg_n',
      'summary_bg_p05',
      'summary_bg_p95',
      'summary_bg_stdv',
    ] as const;

    it.each(DUPLICATED)('compiles a %s brush for bold, T1w and T2w alike', (metric) => {
      for (const modality of ['bold', 'T1w', 'T2w'] as const) {
        const { where, params } = compile(
          [],
          { metric: field(metric), range: [1, 2] },
          modality,
          'raw',
        );
        expect(where).toContain(`isfinite(CAST("${metric}" AS DOUBLE))`);
        expect(params).toEqual([1, 2]);
      }
    });

    it('still refuses a metric that really does not exist for the modality', () => {
      expect(() => compile([], { metric: field('fd_mean'), range: [0, 1] }, 'T1w', 'raw')).toThrow(
        /unknown selection metric/,
      );
    });
  });

  it('conjoins several filters in the order given', () => {
    const { where, params } = compile([
      { field: field(CATEGORICAL), op: 'in', values: ['GE'] },
      { field: field(NUMERIC), op: 'between', lo: 0, hi: 1 },
      { field: field(DATE), op: 'notNull' },
    ]);
    expect(where).toBe(
      'TRUE AND ("manufacturer" IN (?))' +
        ' AND "echo_time" BETWEEN ? AND ?' +
        ' AND "created_at" IS NOT NULL',
    );
    expect(params).toEqual(['GE', 0, 1]);
  });
});
