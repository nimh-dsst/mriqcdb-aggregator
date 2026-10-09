/**
 * Every procedure through `createCaller` against the fixture database, and every
 * way an input is refused.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MetricSummary } from '@mriqc/shared';
import { CATALOG_VERSION } from '@mriqc/shared';
import { publishDataVersion } from '../ingest/version.js';
import {
  MODEL_COUNT,
  NON_FINITE_ROWS,
  RAW_ROWS,
  makeFixture,
  type Fixture,
} from '../testing/fixture.js';
import { createCaller, histogramRange } from './router.js';

let dir: string;
let fixture: Fixture;
let caller: ReturnType<typeof createCaller>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-router-'));
  fixture = await makeFixture(dir);
  caller = createCaller({ db: fixture.db });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` and return the tRPC error it throws. Fails if it does not throw one. */
async function trpcError(fn: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    return error as TRPCError;
  }
  throw new Error('expected the procedure to reject');
}

const scope = { modality: 'bold' as const, view: 'raw' as const, filters: [] };

describe('health', () => {
  it('answers from the real database', async () => {
    const result = await caller.health();
    expect(result.ok).toBe(true);
    expect(result.duckdb).toMatch(/^v\d+\.\d+\.\d+/);
    expect(result.catalogVersion).toBe(CATALOG_VERSION);
  });
});

describe('catalog', () => {
  it('returns the authored catalog completed with database facts', async () => {
    const catalog = await caller.catalog();
    expect(catalog.version).toBe(CATALOG_VERSION);
    expect(catalog.metrics.length).toBeGreaterThan(0);
    expect(catalog.dataVersion).toBe(fixture.result.dataVersion);
    expect(catalog.availableViews).toEqual({
      bold: ['raw', 'k4plus'],
      T1w: ['raw', 'k3pp'],
      T2w: ['raw', 'k3pp'],
    });
  });

  it('lists the distinct values of a categorical field with counts', async () => {
    const catalog = await caller.catalog();
    const values = catalog.fieldValues['manufacturer']?.bold?.raw ?? [];
    expect(values.map((v) => v.value).sort()).toEqual(['GE', 'Philips', 'Siemens', null]);
    expect(values.reduce((a, v) => a + v.n, 0)).toBe(RAW_ROWS);
    // Ordered by count, descending.
    expect([...values].sort((a, b) => b.n - a.n)).toEqual([...values]);
  });

  it('caps a value list at 200 entries', async () => {
    const catalog = await caller.catalog();
    const models = catalog.fieldValues['manufacturers_model_name']?.bold?.raw ?? [];
    expect(models).toHaveLength(MODEL_COUNT);
    expect(models.length).toBeLessThanOrEqual(200);
  });

  it('types a numeric value list back to numbers', async () => {
    const catalog = await caller.catalog();
    const strengths = catalog.fieldValues['magnetic_field_strength']?.bold?.raw ?? [];
    expect(strengths.map((v) => v.value).sort()).toEqual([1.5, 3, 7]);
  });

  it('counts the finite values of every metric per modality and view', async () => {
    const catalog = await caller.catalog();
    expect(catalog.metricCounts['fd_mean']?.bold?.raw).toBe(RAW_ROWS - NON_FINITE_ROWS);
    expect(catalog.metricCounts['fd_mean']?.bold?.k4plus).toBeLessThan(RAW_ROWS);
    // `fd_mean` is bold-only, so T1w has no entry at all.
    expect(catalog.metricCounts['fd_mean']?.T1w).toBeUndefined();
  });

  it('reports the created_at bounds per modality', async () => {
    const catalog = await caller.catalog();
    expect(catalog.dateRange.bold?.min).toMatch(/^2020-01-01T/);
    const last = new Date(Date.UTC(2020, 0, 1 + RAW_ROWS - 1)).toISOString();
    expect(catalog.dateRange.bold?.max).toBe(last);
  });

  it('is cached: two calls return the same object for one data_version', async () => {
    expect(await caller.catalog()).toBe(await caller.catalog());
  });
});

describe('distribution', () => {
  it('returns a summary and a histogram', async () => {
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', bins: 20 });
    expect(result.n).toBeGreaterThan(0);
    expect(result.histogram.counts).toHaveLength(20);
  });

  it('works against a canonical view', async () => {
    const result = await caller.distribution({
      modality: 'bold',
      view: 'k4plus',
      filters: [],
      metric: 'fd_mean',
    });
    expect(result.n).toBeGreaterThan(0);
  });

  it.each([
    ['an unknown metric', { ...scope, metric: 'no_such_metric' }],
    ['a metric of another modality', { modality: 'T1w', view: 'raw', filters: [], metric: 'fd_mean' }],
    ['a view the modality does not have', { modality: 'bold', view: 'k3pp', filters: [], metric: 'fd_mean' }],
    ['more than 200 bins', { ...scope, metric: 'fd_mean', bins: 201 }],
    ['an unknown clip mode', { ...scope, metric: 'fd_mean', clip: 'p10p90' }],
  ] as const)('refuses %s', async (_name, input) => {
    const error = await trpcError(() => caller.distribution(input as never));
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('refuses a filter on a field that is not filterable', async () => {
    const error = await trpcError(() =>
      caller.distribution({
        ...scope,
        filters: [{ field: 'id', op: 'isNull' }],
        metric: 'fd_mean',
      }),
    );
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toMatch(/not filterable/);
  });

  it('matches the rows with no manufacturer when the (none) option is picked', async () => {
    // The empty string is the catalog's merged null-or-empty bucket, not a value:
    // on data whose only absent manufacturers are NULL it must select exactly the
    // same rows as `isNull`, and it must select some.
    const none = await caller.distribution({
      ...scope,
      metric: 'fd_mean',
      filters: [{ field: 'manufacturer', op: 'in', values: [''] }],
    });
    const isNull = await caller.distribution({
      ...scope,
      metric: 'fd_mean',
      filters: [{ field: 'manufacturer', op: 'isNull' }],
    });
    expect(none.n).toBeGreaterThan(0);
    expect(none.n).toBe(isNull.n);

    // And picking it beside a named value is a union, not an intersection.
    const both = await caller.distribution({
      ...scope,
      metric: 'fd_mean',
      filters: [{ field: 'manufacturer', op: 'in', values: ['', 'GE'] }],
    });
    const ge = await caller.distribution({
      ...scope,
      metric: 'fd_mean',
      filters: [{ field: 'manufacturer', op: 'in', values: ['GE'] }],
    });
    expect(both.n).toBe(none.n + ge.n);
  });

  it('refuses an in list over 500 values', async () => {
    const error = await trpcError(() =>
      caller.distribution({
        ...scope,
        filters: [
          {
            field: 'manufacturer',
            op: 'in',
            values: Array.from({ length: 501 }, (_, i) => `v${i}`),
          },
        ],
        metric: 'fd_mean',
      }),
    );
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toMatch(/over the 500 limit/);
  });
});

describe('groupedSummary', () => {
  it('returns groups and the fold', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'manufacturers_model_name',
    });
    expect(result.groups).toHaveLength(50);
    expect(result.other).toBeDefined();
  });

  it('refuses a group field that is not groupable', async () => {
    const error = await trpcError(() =>
      caller.groupedSummary({ ...scope, metric: 'fd_mean', group: 'id' }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('refuses a group field that belongs to another view', async () => {
    const error = await trpcError(() =>
      caller.groupedSummary({ ...scope, metric: 'fd_mean', group: 'canonical_hmc_mode' }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('accepts that same field in the view that has it', async () => {
    const result = await caller.groupedSummary({
      modality: 'bold',
      view: 'k4plus',
      filters: [],
      metric: 'fd_mean',
      group: 'canonical_hmc_mode',
    });
    expect(result.groups.map((g) => g.value)).toEqual(['6dof']);
  });
});

describe('coverage', () => {
  it('returns one bucket per time bucket and group value', async () => {
    const result = await caller.coverage({ ...scope, group: 'manufacturer', granularity: 'month' });
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets[0]).toMatchObject({ n: expect.any(Number) });
  });

  it('refuses an unknown granularity', async () => {
    const error = await trpcError(() =>
      caller.coverage({ ...scope, group: 'manufacturer', granularity: 'fortnight' as never }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('sample', () => {
  it('returns rows and a cursor', async () => {
    const page = await caller.sample({ ...scope, columns: ['id', 'fd_mean'], limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('refuses a column that is not exportable', async () => {
    const error = await trpcError(() =>
      caller.sample({ ...scope, columns: ['provenance_settings_fd_thres'], limit: 10 }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('refuses a limit over 500', async () => {
    const error = await trpcError(() =>
      caller.sample({ ...scope, columns: ['id'], limit: 501 }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('refuses a cursor it did not produce', async () => {
    const error = await trpcError(() =>
      caller.sample({ ...scope, columns: ['id'], limit: 10, cursor: 'not-a-cursor' }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('value typing', () => {
  it('answers BAD_REQUEST, not 500, for a value DuckDB cannot convert', async () => {
    // `magnetic_field_strength` is a DOUBLE column served as a categorical value
    // list, so the pure compiler cannot type this: the conversion error DuckDB
    // raises is what has to be mapped.
    const error = await trpcError(() =>
      caller.distribution({
        ...scope,
        metric: 'fd_mean',
        filters: [{ field: 'magnetic_field_strength', op: 'in', values: ['three tesla'] }],
      }),
    );
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).not.toMatch(/magnetic_field_strength/);
  });

  it('answers BAD_REQUEST for a date bound that is not a date', async () => {
    const error = await trpcError(() =>
      caller.distribution({
        ...scope,
        metric: 'fd_mean',
        filters: [{ field: 'created_at', op: 'between', lo: 'yesterday', hi: 'today' }],
      }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('answers BAD_REQUEST for a non-number in an `in` list on a numeric field', async () => {
    const error = await trpcError(() =>
      caller.distribution({
        ...scope,
        metric: 'fd_mean',
        filters: [{ field: 'echo_time', op: 'in', values: ['0.03'] }],
      }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('one connection per procedure', () => {
  it('runs every statement of a grouped summary inside one read', async () => {
    const reads = vi.spyOn(fixture.db, 'withRead');
    try {
      // A numeric group needs three statements: bounds, stats, histograms. Each one
      // used to take its own connection and its own fresh 30 s budget.
      const result = await caller.groupedSummary({
        ...scope,
        metric: 'fd_mean',
        group: 'echo_time',
      });
      expect(result.groups.length).toBeGreaterThan(1);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  it('bins the canonical-only numeric fields like any other numeric group', async () => {
    const canonical = { modality: 'bold' as const, view: 'k4plus' as const, filters: [] };
    for (const group of ['canonical_group_rows', 'canonical_diameter'] as const) {
      const result = await caller.groupedSummary({ ...canonical, metric: 'fd_mean', group });
      // Bin labels, not one group per distinct value: the fixture's diameter is
      // `i * 0.01` over thousands of rows, so a value grouping would blow the cap.
      expect(result.groups.length).toBeGreaterThan(1);
      expect(result.groups.every((g) => String(g.value).includes('–'))).toBe(true);
      expect(new Set(result.groups.map((g) => String(g.value))).size).toBe(result.groups.length);
    }
  });

  it('narrows a canonical view by a range on canonical_diameter', async () => {
    const canonical = { modality: 'bold' as const, view: 'k4plus' as const };
    const all = await caller.distribution({ ...canonical, filters: [], metric: 'fd_mean' });
    const narrowed = await caller.distribution({
      ...canonical,
      // The open end a one-sided range control sends.
      filters: [{ field: 'canonical_diameter', op: 'between', lo: -(2 ** 52) + 0.5, hi: 0.5 }],
      metric: 'fd_mean',
    });
    expect(narrowed.n).toBeGreaterThan(0);
    expect(narrowed.n).toBeLessThan(all.n);
  });

  it('labels numeric group bins distinctly', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'echo_time',
    });
    const labels = result.groups.map((g) => String(g.value));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => l.includes('–'))).toBe(true);
  });
});

describe('degenerate clip ranges', () => {
  const summary = (min: number, max: number, q: number): MetricSummary => ({
    n: 100,
    min,
    max,
    mean: q,
    stddev: 0,
    quantiles: { p01: q, p05: q, p25: q, p50: q, p75: q, p95: q, p99: q },
  });

  it('falls back to [min, max] when the clip quantiles coincide but the data does not', () => {
    // Otherwise the response claims every finite row sits at one zero-width bin
    // while reporting a min and max that say otherwise.
    expect(histogramRange(summary(0, 9, 0), 'p01p99')).toEqual([0, 9]);
    expect(histogramRange(summary(0, 9, 0), 'p05p95')).toEqual([0, 9]);
  });

  it('keeps the single bin when the data really is one value', () => {
    expect(histogramRange(summary(4, 4, 4), 'p01p99')).toEqual([4, 4]);
  });

  it('is the ordinary clip range otherwise', () => {
    const spread: MetricSummary = {
      n: 10,
      min: 0,
      max: 10,
      mean: 5,
      stddev: 1,
      quantiles: { p01: 1, p05: 2, p25: 3, p50: 5, p75: 7, p95: 8, p99: 9 },
    };
    expect(histogramRange(spread, 'p01p99')).toEqual([1, 9]);
    expect(histogramRange(spread, 'none')).toEqual([0, 10]);
  });
});

describe('dataVersion', () => {
  it('emits the current version immediately, then every change', async () => {
    const stream = await caller.dataVersion();
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(fixture.result.dataVersion);

    const next = iterator.next();
    publishDataVersion(fixture.db, 'version-two');
    expect((await next).value).toBe('version-two');

    await iterator.return?.(undefined);
    // Put the fixture's real version back for any later assertion.
    publishDataVersion(fixture.db, fixture.result.dataVersion);
  });
});
