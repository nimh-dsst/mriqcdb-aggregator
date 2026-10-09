/**
 * The SQL templates against the fixture database.
 *
 * Every expected number is recomputed in TypeScript from the fixture's generating
 * rule, so the tests assert the templates' arithmetic rather than echo it. The
 * fixture deliberately contains NaN, +Inf and NULL, so the `isfinite` handling is
 * asserted at every aggregate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NONE_LABEL, asColumnId } from '@mriqc/shared';
import { createCaller } from '../trpc/router.js';
import {
  MODEL_COUNT,
  NON_FINITE_ROWS,
  RAW_ROWS,
  finiteMetricValues,
  makeFixture,
  manufacturerOf,
  quantileCont,
  type Fixture,
} from '../testing/fixture.js';

let dir: string;
let fixture: Fixture;
let caller: ReturnType<typeof createCaller>;

/** The finite `fd_mean` values of `raw_bold`, ascending -- what every aggregate sees. */
const finite = finiteMetricValues();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-tpl-'));
  fixture = await makeFixture(dir);
  caller = createCaller({ db: fixture.db });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

const scope = { modality: 'bold' as const, view: 'raw' as const, filters: [] };

describe('distribution', () => {
  it('counts only the finite values, excluding NaN, Inf and NULL', async () => {
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', clip: 'none' });
    expect(result.n).toBe(finite.length);
    expect(result.n).toBe(RAW_ROWS - NON_FINITE_ROWS);
    expect(result.min).toBe(finite[0]);
    expect(result.max).toBe(finite[finite.length - 1]);
  });

  it('returns the mean and population standard deviation of the finite values', async () => {
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', clip: 'none' });
    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length;
    expect(result.mean).toBeCloseTo(mean, 10);
    expect(result.stddev).toBeCloseTo(Math.sqrt(variance), 10);
  });

  it('returns the seven quantiles the template asks for, interpolated', async () => {
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', clip: 'none' });
    const q = result.quantiles;
    expect(q).not.toBeNull();
    const expected = {
      p01: quantileCont(finite, 0.01),
      p05: quantileCont(finite, 0.05),
      p25: quantileCont(finite, 0.25),
      p50: quantileCont(finite, 0.5),
      p75: quantileCont(finite, 0.75),
      p95: quantileCont(finite, 0.95),
      p99: quantileCont(finite, 0.99),
    };
    for (const [key, value] of Object.entries(expected)) {
      expect([key, (q as unknown as Record<string, number>)[key]]).toEqual([key, value]);
    }
  });

  it('bins every finite value when the range is unclipped, so the counts sum to n', async () => {
    const bins = 50;
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', bins, clip: 'none' });
    expect(result.histogram.counts).toHaveLength(bins);
    const total = result.histogram.counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(result.n);

    // The same equal-width bins, computed here.
    const { lo, width } = result.histogram;
    const expected = new Array<number>(bins).fill(0);
    for (const x of finite) {
      const bin = Math.min(bins - 1, Math.floor((x - lo) / width));
      expected[bin] = (expected[bin] ?? 0) + 1;
    }
    expect([...result.histogram.counts]).toEqual(expected);
  });

  it('clips the histogram range to the requested quantiles', async () => {
    const result = await caller.distribution({ ...scope, metric: 'fd_mean', clip: 'p01p99' });
    const q = result.quantiles as { p01: number; p99: number };
    expect(result.histogram.lo).toBe(q.p01);
    expect(result.histogram.hi).toBe(q.p99);
    const inside = finite.filter((x) => x >= q.p01 && x <= q.p99).length;
    expect(result.histogram.counts.reduce((a, b) => a + b, 0)).toBe(inside);
    expect(inside).toBeLessThan(result.n);
  });

  it('applies filters to both the statistics and the histogram', async () => {
    const result = await caller.distribution({
      ...scope,
      filters: [{ field: 'manufacturer', op: 'in', values: ['Siemens'] }],
      metric: 'fd_mean',
      clip: 'none',
    });
    const expected = finite.filter((x) => manufacturerOf(x * 2) === 'Siemens');
    expect(result.n).toBe(expected.length);
    expect(result.histogram.counts.reduce((a, b) => a + b, 0)).toBe(result.n);
  });

  it('returns an empty histogram when nothing matches', async () => {
    const result = await caller.distribution({
      ...scope,
      filters: [{ field: 'manufacturer', op: 'in', values: ['Nobody'] }],
      metric: 'fd_mean',
    });
    expect(result).toMatchObject({ n: 0, min: null, max: null, quantiles: null });
    expect(result.histogram.counts).toEqual([]);
  });

  describe('an explicitly requested range', () => {
    // The fixture's finite `fd_mean` values are `i * 0.5` over 3000 rows, so they
    // span 0 to 1499.5 and a range of [100, 200] is crossed by all three parts:
    // values below it, values inside it, and values above it.
    const RANGE: [number, number] = [100, 200];
    const bins = 20;

    it('bins over exactly the requested range and counts what falls outside it', async () => {
      const result = await caller.distribution({
        ...scope,
        metric: 'fd_mean',
        bins,
        range: RANGE,
      });
      const [lo, hi] = RANGE;
      const width = (hi - lo) / bins;
      expect(result.histogram.lo).toBe(lo);
      expect(result.histogram.hi).toBe(hi);
      expect(result.histogram.width).toBe(width);
      expect(result.histogram.counts).toHaveLength(bins);

      // Every count recomputed here from the fixture's generating rule.
      const expected = new Array<number>(bins).fill(0);
      let under = 0;
      let over = 0;
      for (const x of finite) {
        if (x < lo) under += 1;
        else if (x > hi) over += 1;
        else {
          const bin = Math.min(bins - 1, Math.floor((x - lo) / width));
          expected[bin] = (expected[bin] ?? 0) + 1;
        }
      }
      expect([...result.histogram.counts]).toEqual(expected);
      expect(result.histogram.underflow).toBe(under);
      expect(result.histogram.overflow).toBe(over);
      expect(under).toBeGreaterThan(0);
      expect(over).toBeGreaterThan(0);

      // Nothing is silently dropped: the three parts account for every finite row.
      const inside = result.histogram.counts.reduce((a, b) => a + b, 0);
      expect(inside + (result.histogram.underflow ?? 0) + (result.histogram.overflow ?? 0)).toBe(
        result.n,
      );
    });

    it('keeps the statistics over the whole filtered set, not over the range', async () => {
      const ranged = await caller.distribution({ ...scope, metric: 'fd_mean', bins, range: RANGE });
      const plain = await caller.distribution({ ...scope, metric: 'fd_mean', bins, clip: 'none' });
      expect(ranged.n).toBe(plain.n);
      expect(ranged.min).toBe(plain.min);
      expect(ranged.max).toBe(plain.max);
      expect(ranged.mean).toBe(plain.mean);
      expect(ranged.quantiles).toEqual(plain.quantiles);
    });

    it('gives two cohorts asked for the same range identical bin edges', async () => {
      // The whole reason the parameter exists: overlaid histograms over different
      // bin edges would lie. Two cohorts here are two different filters.
      const cohort = (values: string[]) =>
        caller.distribution({
          ...scope,
          filters: [{ field: 'manufacturer', op: 'in', values }],
          metric: 'fd_mean',
          bins,
          range: RANGE,
        });
      const [siemens, ge] = await Promise.all([cohort(['Siemens']), cohort(['GE'])]);

      expect(siemens.n).not.toBe(ge.n);
      expect(siemens.histogram.lo).toBe(ge.histogram.lo);
      expect(siemens.histogram.width).toBe(ge.histogram.width);
      expect(siemens.histogram.hi).toBe(ge.histogram.hi);
      expect(siemens.histogram.counts).toHaveLength(ge.histogram.counts.length);
      for (const c of [siemens, ge]) {
        const inside = c.histogram.counts.reduce((a, b) => a + b, 0);
        expect(inside + (c.histogram.underflow ?? 0) + (c.histogram.overflow ?? 0)).toBe(c.n);
      }
      // The clipped default would have given each cohort its own quantile range,
      // which is exactly what a comparison must not do.
      const clippedCohort = (values: string[]) =>
        caller.distribution({
          ...scope,
          filters: [{ field: 'manufacturer', op: 'in', values }],
          metric: 'fd_mean',
          bins,
        });
      const [clippedSiemens, clippedGe] = await Promise.all([
        clippedCohort(['Siemens']),
        clippedCohort(['GE']),
      ]);
      expect(clippedSiemens.histogram.lo).not.toBe(clippedGe.histogram.lo);
    });

    it('keeps the requested edges even for a cohort with no rows at all', async () => {
      const result = await caller.distribution({
        ...scope,
        filters: [{ field: 'manufacturer', op: 'in', values: ['Nobody'] }],
        metric: 'fd_mean',
        bins,
        range: RANGE,
      });
      expect(result.n).toBe(0);
      expect(result.histogram.lo).toBe(RANGE[0]);
      expect(result.histogram.hi).toBe(RANGE[1]);
      expect(result.histogram.counts).toEqual(new Array<number>(bins).fill(0));
      expect(result.histogram.underflow).toBe(0);
      expect(result.histogram.overflow).toBe(0);
    });

    it('applies the filters and the selection to the ranged histogram too', async () => {
      const result = await caller.distribution({
        ...scope,
        metric: 'fd_mean',
        bins,
        range: RANGE,
        selection: { metric: asColumnId('fd_mean'), range: [120, 180] },
      });
      const kept = finite.filter((x) => x >= 120 && x <= 180);
      expect(result.n).toBe(kept.length);
      const inside = result.histogram.counts.reduce((a, b) => a + b, 0);
      expect(inside).toBe(kept.length);
      expect(result.histogram.underflow).toBe(0);
      expect(result.histogram.overflow).toBe(0);
    });

    it('leaves underflow and overflow out when no range was asked for', async () => {
      const result = await caller.distribution({ ...scope, metric: 'fd_mean', bins });
      expect(result.histogram.underflow).toBeUndefined();
      expect(result.histogram.overflow).toBeUndefined();
    });

    it.each([
      ['an inverted range', [200, 100]],
      ['a zero-width range', [100, 100]],
      ['a non-finite bound', [0, Number.POSITIVE_INFINITY]],
    ] as ReadonlyArray<readonly [string, [number, number]]>)('refuses %s', async (_name, range) => {
      await expect(
        caller.distribution({ ...scope, metric: 'fd_mean', bins, range }),
      ).rejects.toThrow();
    });
  });

  it('honours a linked selection as an extra predicate', async () => {
    const result = await caller.distribution({
      ...scope,
      metric: 'fd_mean',
      clip: 'none',
      selection: { metric: asColumnId('fd_mean'), range: [10, 20] },
    });
    expect(result.n).toBe(finite.filter((x) => x >= 10 && x <= 20).length);
  });
});

describe('groupedSummary', () => {
  it('splits by a categorical column, keeping the null group distinct', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'manufacturer',
    });
    expect(result.other).toBeUndefined();
    const byValue = new Map(result.groups.map((g) => [g.value, g.n]));
    expect(new Set(byValue.keys())).toEqual(new Set([null, 'GE', 'Philips', 'Siemens']));

    const expected = new Map<string | null, number>();
    for (let i = 0; i < RAW_ROWS; i += 1) {
      if (i % 50 === 7 || i % 50 === 17 || i % 50 === 27) continue;
      const key = manufacturerOf(i);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    for (const [value, n] of expected) expect([value, byValue.get(value)]).toEqual([value, n]);
  });

  it('caps the group list and folds the remainder into other', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'manufacturers_model_name',
    });
    expect(MODEL_COUNT).toBeGreaterThan(50);
    expect(result.groups).toHaveLength(50);
    expect(result.other).toBeDefined();
    expect(result.other?.value).toBe('other');

    const grouped = result.groups.reduce((a, g) => a + g.n, 0);
    expect(grouped + (result.other?.n ?? 0)).toBe(finite.length);
    // Every kept group is at least as large as the fold's average member.
    const smallest = Math.min(...result.groups.map((g) => g.n));
    expect(smallest).toBeGreaterThan(0);
  });

  it('gives every group a histogram over one shared range', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'manufacturer',
    });
    const [first] = result.groups;
    expect(first).toBeDefined();
    for (const group of result.groups) {
      expect(group.histogram.lo).toBe(first?.histogram.lo);
      expect(group.histogram.hi).toBe(first?.histogram.hi);
      expect(group.histogram.counts.reduce((a, b) => a + b, 0)).toBe(group.n);
    }
  });

  it('bins a numeric group column into labelled ranges', async () => {
    const result = await caller.groupedSummary({
      ...scope,
      metric: 'fd_mean',
      group: 'echo_time',
    });
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.length).toBeLessThanOrEqual(10);
    for (const group of result.groups) {
      expect(String(group.value)).toMatch(/^-?[\d.]+–-?[\d.]+$/);
    }
    expect(result.groups.reduce((a, g) => a + g.n, 0)).toBe(finite.length);
  });
});

describe('coverage', () => {
  it('buckets every dated row by month, and the bucket counts sum to the row count', async () => {
    const result = await caller.coverage({ ...scope, group: 'manufacturer', granularity: 'month' });
    expect(result.buckets.reduce((a, b) => a + b.n, 0)).toBe(RAW_ROWS);
    // One bucket per calendar month the consecutive daily rows fall in.
    const months = new Set<string>();
    for (let i = 0; i < RAW_ROWS; i += 1) {
      const day = new Date(Date.UTC(2020, 0, 1 + i));
      months.add(`${day.getUTCFullYear()}-${day.getUTCMonth()}`);
    }
    expect(new Set(result.buckets.map((b) => b.start)).size).toBe(months.size);
    for (const bucket of result.buckets) expect(bucket.start).toMatch(/^\d{4}-\d\d-01T00:00:00/);
  });

  it('labels the null group the way every value list labels it', async () => {
    // One name for one thing: the axis, the legend and the filter list all
    // read `NONE_LABEL`, so the server writes that and never its own spelling.
    const result = await caller.coverage({ ...scope, group: 'manufacturer', granularity: 'year' });
    const none = result.buckets.filter((b) => b.group === NONE_LABEL);
    const expected = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(
      (i) => manufacturerOf(i) === null,
    ).length;
    expect(none.reduce((a, b) => a + b.n, 0)).toBe(expected);
  });

  it.each(['day', 'week', 'month', 'year'] as const)(
    'keeps the total constant at %s granularity',
    async (granularity) => {
      const result = await caller.coverage({ ...scope, group: 'manufacturer', granularity });
      expect(result.buckets.reduce((a, b) => a + b.n, 0)).toBe(RAW_ROWS);
    },
  );

  it('applies filters before bucketing', async () => {
    const result = await caller.coverage({
      ...scope,
      filters: [{ field: 'manufacturer', op: 'in', values: ['GE'] }],
      group: 'manufacturer',
      granularity: 'year',
    });
    const expected = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(
      (i) => manufacturerOf(i) === 'GE',
    ).length;
    expect(result.buckets.reduce((a, b) => a + b.n, 0)).toBe(expected);
  });
});

describe('sample', () => {
  it('pages through every row with no overlap and no gap', async () => {
    const limit = 500;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof caller.sample>> = await caller.sample({
        ...scope,
        columns: ['id', 'created_at', 'fd_mean'],
        limit,
        cursor,
      });
      pages += 1;
      seen.push(...page.rows.map((r) => String(r['id'])));
      cursor = page.nextCursor;
      if (cursor === null) break;
      expect(pages).toBeLessThan(RAW_ROWS / limit + 2);
    }
    expect(pages).toBe(RAW_ROWS / limit + 1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(RAW_ROWS);
  });

  it('orders by created_at descending', async () => {
    const page = await caller.sample({ ...scope, columns: ['id'], limit: 5 });
    const ids = page.rows.map((r) => String(r['id']));
    const last = RAW_ROWS - 1;
    expect(ids[0]).toBe(`bold-${String(last).padStart(4, '0')}`);
    expect(ids[4]).toBe(`bold-${String(last - 4).padStart(4, '0')}`);
  });

  it('returns only the requested columns plus the keyset columns', async () => {
    const page = await caller.sample({ ...scope, columns: ['fd_mean'], limit: 1 });
    expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual(['created_at', 'fd_mean', 'id']);
  });

  it('applies filters to the page', async () => {
    const page = await caller.sample({
      ...scope,
      filters: [{ field: 'manufacturer', op: 'in', values: ['Philips'] }],
      columns: ['id', 'manufacturer'],
      limit: 500,
    });
    expect(page.rows.every((r) => r['manufacturer'] === 'Philips')).toBe(true);
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it('ends the keyset with a null cursor when a page is not full', async () => {
    const page = await caller.sample({
      ...scope,
      filters: [{ field: 'manufacturer', op: 'isNull' }],
      columns: ['id', 'manufacturer'],
      limit: 500,
    });
    const expected = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(
      (i) => manufacturerOf(i) === null,
    ).length;
    expect(page.rows).toHaveLength(expected);
    expect(expected).toBeLessThan(500);
    expect(page.nextCursor).toBeNull();
  });

  it('serializes timestamps as ISO text and leaves NaN out of JSON reach', async () => {
    const page = await caller.sample({ ...scope, columns: ['created_at'], limit: 1 });
    const newest = new Date(Date.UTC(2020, 0, 1 + RAW_ROWS - 1)).toISOString();
    expect(page.rows[0]?.['created_at']).toBe(newest);
  });
});
