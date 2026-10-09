import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asColumnId, binnedSummaryFragments, continuousAxisExpr, compileFiltersCore, type Granularity, type BinnedSummaryBucket } from '@mriqc/shared';
import { fill, loadTemplate } from '../sql/run.js';
import {
  RAW_ROWS, isInfRow, isNaNRow, isNullRow, makeFixture, manufacturerOf, quantileCont,
  type Fixture,
} from '../testing/fixture.js';
import { createCaller } from './router.js';

let dir: string;
let fixture: Fixture;
let caller: ReturnType<typeof createCaller>;
const scope = { modality: 'bold' as const, view: 'raw' as const };
const input = { ...scope, x: 'created_at', y: 'fd_mean', bins: 'month' as const };
const day = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString();
const epochDay = (i: number) => (Date.parse(day(i)) - Date.UTC(2000, 0, 1)) / 86_400_000;
const finite = (i: number) => !isNaNRow(i) && !isInfRow(i) && !isNullRow(i);
const indices = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(finite);
function expected(rows: number[]) {
  const values = rows.map(i => i * 0.5).sort((a, b) => a - b);
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    quantiles: { p05: quantileCont(values, 0.05), p25: quantileCont(values, 0.25),
      p50: quantileCont(values, 0.5), p75: quantileCont(values, 0.75), p95: quantileCont(values, 0.95) },
    thin: values.length < 20,
  };
}

function expectStats(bucket: BinnedSummaryBucket, rows: number[]): void {
  const want = expected(rows);
  expect(bucket.n).toBe(want.n);
  expect(bucket.thin).toBe(want.thin);
  expect(bucket.mean).toBeCloseTo(want.mean, 10);
  for (const key of ['p05', 'p25', 'p50', 'p75', 'p95'] as const) {
    expect(bucket.quantiles[key]).toBeCloseTo(want.quantiles[key], 10);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-time-summary-'));
  fixture = await makeFixture(dir);
  caller = createCaller({ db: fixture.db });
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('binnedSummary', () => {
  it('summarizes time y in epoch days over metric bins, including empty cohorts', async () => {
    const query = { ...input, x: 'fd_mean', y: 'created_at', bins: 2, range: [0, 10] as [number, number] };
    const result = await caller.binnedSummary(query);
    expect(result).toMatchObject({ xKind: 'metric', yKind: 'time', range: [0, 10] });
    for (const [bin, bucket] of result.buckets.entries()) {
      const values = indices.filter(i => bin === 0 ? i < 10 : i >= 10 && i <= 20).map(epochDay);
      expect(bucket.n).toBe(values.length);
      expect(bucket.mean).toBeCloseTo(values.reduce((sum, value) => sum + value, 0) / values.length, 10);
      for (const [key, q] of [['p05', .05], ['p25', .25], ['p50', .5], ['p75', .75], ['p95', .95]] as const) {
        expect(bucket.quantiles[key]).toBeCloseTo(quantileCont(values, q), 10);
      }
    }
    const empty = await caller.binnedSummary({ ...query, filters: [{ field: 'manufacturer', op: 'in', values: ['absent'] }] });
    expect(empty).toEqual({ xKind: 'metric', yKind: 'time', range: [0, 10], buckets: [] });
    expect((await caller.binnedSummary(input)).yKind).toBe('metric');
    expect((await caller.binnedSummary({ ...input, y: 'created_at' })).yKind).toBe('time');
  });

  it('bins metric x over p01–p99 and computes independent finite y quantiles', async () => {
    const result = await caller.binnedSummary({ ...input, x: 'fd_mean', bins: 8 });
    const values = indices.map(i => i * 0.5);
    const lo = quantileCont(values, 0.01), hi = quantileCont(values, 0.99);
    expect(result.xKind).toBe('metric');
    expect(result.range).toEqual([lo, hi]);
    expect(result.buckets).toHaveLength(8);
    for (let bin = 0; bin < 8; bin += 1) {
      const bucket = result.buckets[bin]!;
      expect(bucket.start).toBeUndefined();
      expect(bucket.lo).toBeCloseTo(lo + bin * (hi - lo) / 8, 10);
      expect(bucket.hi).toBeCloseTo(lo + (bin + 1) * (hi - lo) / 8, 10);
      expectStats(bucket, indices.filter(i => i * 0.5 >= lo && i * 0.5 <= hi &&
        Math.min(7, Math.floor((i * 0.5 - lo) / (hi - lo) * 8)) === bin));
    }
  });

  it('uses both metrics for finite-pair clipping, with independent y holes', async () => {
    const result = await caller.binnedSummary({ ...input, x: 'fwhm_y', bins: 5, range: [0, 30] });
    const kept = indices.filter(i => ![8, 18, 28].includes(i % 50))
      .filter(i => 2 * Math.floor(i / 3) + (i % 7) / 10 <= 30);
    expect(result.buckets.reduce((n, b) => n + b.n, 0)).toBe(kept.length);
    for (const bucket of result.buckets) {
      const bin = Math.round(bucket.lo / 6);
      expectStats(bucket, kept.filter(i => Math.min(4, Math.floor((2 * Math.floor(i / 3) + (i % 7) / 10) / 6)) === bin));
    }
  });

  it('preserves explicit edges, includes both endpoints, and handles empty/constant populations', async () => {
    const query = { ...input, x: 'fd_mean', bins: 2, range: [0, 10] as [number, number] };
    const result = await caller.binnedSummary(query);
    expect(result.buckets.map(b => [b.lo, b.hi])).toEqual([[0, 5], [5, 10]]);
    expectStats(result.buckets[0]!, indices.filter(i => i < 10));
    expectStats(result.buckets[1]!, indices.filter(i => i >= 10 && i <= 20));
    const empty = await caller.binnedSummary({ ...query, filters: [{ field: 'manufacturer', op: 'in', values: ['absent'] }] });
    expect(empty).toEqual({ xKind: 'metric', yKind: 'metric', range: [0, 10], buckets: [] });
    const single = await caller.binnedSummary({ ...input, x: 'fd_mean', bins: 20,
      selections: [{ metric: 'fd_mean', range: [0, 0] }] });
    expect(single.range).toEqual([0, 0]);
    expect(single.buckets).toHaveLength(1);
    expect(single.buckets[0]).toMatchObject({ lo: 0, hi: 0, n: 1, mean: 0 });
  });

  it('uses a two-step shared range across cohort scopes and intersects outer predicates', async () => {
    const cohorts = ['GE', 'Siemens', 'absent'].map(id => ({ id,
      filters: [{ field: 'manufacturer', op: 'in' as const, values: [id] }],
      selections: [{ metric: 'fd_mean', range: [10, 50] as [number, number] }],
    }));
    const query = { ...input, x: 'fd_mean', bins: 4,
      selections: [{ metric: 'fd_mean', range: [20, 70] as [number, number] }] };
    const independent = await Promise.all(cohorts.slice(0, 2).map(c => caller.binnedSummary({ ...query,
      filters: c.filters, selections: [{ metric: 'fd_mean', range: [20, 50] }],
    })));
    const range: [number, number] = [Math.min(...independent.map(r => r.range[0])), Math.max(...independent.map(r => r.range[1]))];
    const result = await caller.binnedSummary({ ...query, cohorts });
    expect(result.range).toEqual(range);
    for (const cohort of cohorts) {
      const expected = await caller.binnedSummary({ ...query, range, filters: cohort.filters,
        selections: [{ metric: 'fd_mean', range: [20, 50] }],
      });
      expect(result.buckets.filter(b => b.cohort === cohort.id)).toEqual(
        expected.buckets.map(b => ({ ...b, cohort: cohort.id })));
    }
  });

  it('returns independently known monthly quantiles, means and counts including nonfinite holes', async () => {
    const result = await caller.binnedSummary(input);
    const byMonth = new Map<string, number[]>();
    for (const i of indices) {
      const start = day(i).slice(0, 7) + '-01T00:00:00.000Z';
      byMonth.set(start, [...(byMonth.get(start) ?? []), i]);
    }
    expect(result.buckets).toHaveLength(byMonth.size);
    for (const bucket of result.buckets) {
      expect(bucket).toMatchObject({ group: null, isOther: false });
      expectStats(bucket, byMonth.get(bucket.start!)!);
    }
    expect(result.buckets[0]?.quantiles.p50).toBe(7.25);
  });

  it.each<Granularity>(['day', 'week', 'month', 'year'])('uses %s calendar boundaries and conserves rows', async granularity => {
    const { buckets } = await caller.binnedSummary({ ...input, bins: granularity });
    expect(buckets[0]?.start).toBe(granularity === 'week' ? '2019-12-30T00:00:00.000Z' : day(0));
    expect(buckets.reduce((n, b) => n + b.n, 0)).toBe(indices.length);
    if (granularity === 'day') expect(buckets.every(b => b.n === 1 && b.thin)).toBe(true);
  });

  it.each([
    ['bold', 'k4plus', 'fd_mean'], ['T1w', 'raw', 'cjv'],
    ['T1w', 'k3pp', 'cjv'], ['T2w', 'k3pp', 'cjv'],
  ] as const)('works for %s/%s', async (modality, view, metric) => {
    const result = await caller.binnedSummary({ ...input, modality, view, y: metric });
    expect(result.buckets.reduce((n, b) => n + b.n, 0)).toBe(
      indices.filter(i => view === 'raw' || i % 2 === 0).length);
  });

  it('applies inclusive window bounds before grouping, with partial boundary buckets', async () => {
    const { buckets } = await caller.binnedSummary({ ...input, range: [epochDay(30), epochDay(60)] });
    expect(buckets.map(b => b.start)).toEqual([day(0), day(31), day(60)]);
    expect(buckets.map(b => b.n)).toEqual([1, indices.filter(i => i >= 31 && i < 60).length, 1]);
    const single = await caller.binnedSummary({ ...input, range: [epochDay(30), epochDay(30) + 0.5] });
    expect(single.buckets[0]).toMatchObject({ n: 1, mean: 15 });
    expect(await caller.binnedSummary({ ...input, range: [3653, 4017] })).toMatchObject({ buckets: [], range: [3653, 4017], xKind: 'time' });
  });

  it('keeps nineteen rows thin and twenty rows non-thin', async () => {
    for (const [last, n, thin] of [[20, 19, true], [21, 20, false]] as const) {
      const { buckets } = await caller.binnedSummary({ ...input, range: [epochDay(0), epochDay(last)] });
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({ n, thin });
    }
  });

  it('ANDs ordinary filters, two selections and the date window', async () => {
    const { buckets } = await caller.binnedSummary({ ...input,
      range: [epochDay(10), epochDay(90)],
      filters: [{ field: 'manufacturer', op: 'in', values: ['GE'] }],
      selections: [{ metric: 'fd_mean', range: [5, 40] }, { metric: 'efc', range: [2, 6] }],
    });
    const kept = indices.filter(i => i >= 10 && i <= 80 && manufacturerOf(i) === 'GE' && i % 13 >= 2 && i % 13 <= 5);
    expect(buckets.reduce((n, b) => n + b.n, 0)).toBe(kept.length);
    for (const bucket of buckets) {
      expectStats(bucket, kept.filter(i => day(i).slice(0, 7) === bucket.start!.slice(0, 7)));
    }
  });

  it('normalizes the legacy alias and accepts an empty array and a null alias', async () => {
    const selection = { metric: 'fd_mean', range: [10, 20] as [number, number] };
    expect(await caller.binnedSummary({ ...input, selection })).toEqual(
      await caller.binnedSummary({ ...input, selections: [selection] }));
    expect(await caller.binnedSummary({ ...input, selections: [], selection: null })).toEqual(
      await caller.binnedSummary(input));
  });

  it('caps groups globally at fifty and computes Other quantiles from its observations', async () => {
    const { buckets } = await caller.binnedSummary({ ...input, groups: 'manufacturers_model_name' });
    const model = (i: number) => `Model-${String(i % 60).padStart(2, '0')}`;
    const counts = new Map<string, number>();
    for (const i of indices) counts.set(model(i), (counts.get(model(i)) ?? 0) + 1);
    const top = new Set([...counts].sort(([a, n], [b, m]) => m - n || a.localeCompare(b)).slice(0, 50).map(([name]) => name));
    expect(new Set(buckets.filter(b => !b.isOther).map(b => b.group))).toEqual(top);
    expect(buckets.some(b => b.isOther)).toBe(true);
    expect(buckets.reduce((n, b) => n + b.n, 0)).toBe(indices.length);
    const monthly = new Map<string, number[]>();
    for (const i of indices) {
      const month = day(i).slice(0, 7);
      monthly.set(month, [...(monthly.get(month) ?? []), i]);
    }
    for (const bucket of buckets) {
      const kept = monthly.get(bucket.start!.slice(0, 7))!.filter(i =>
        bucket.isOther ? !top.has(model(i)) : model(i) === bucket.group);
      expectStats(bucket, kept);
      if (bucket.isOther) expect(bucket.group).toBe('Other');
    }
  });

  it('retains missing categorical values as Not reported', async () => {
    const { buckets } = await caller.binnedSummary({ ...input, groups: 'manufacturer' });
    expect(new Set(buckets.map(b => b.group))).toEqual(new Set(['Siemens', 'GE', 'Philips', 'Not reported']));
    expect(buckets.every(b => !b.isOther)).toBe(true);
    expect(buckets.filter(b => b.group === 'Not reported').reduce((n, b) => n + b.n, 0)).toBe(
      indices.filter(i => manufacturerOf(i) === null).length);
  });

  it('bins numeric groups using the filtered window domain and handles a degenerate domain', async () => {
    const { buckets } = await caller.binnedSummary({ ...input, groups: 'echo_time', range: [epochDay(0), epochDay(99)] });
    expect(new Set(buckets.map(b => b.group)).size).toBe(5);
    expect(buckets.every(b => typeof b.group === 'string' && b.group.includes('–'))).toBe(true);
    expect(buckets.reduce((n, b) => n + b.n, 0)).toBe(indices.filter(i => i <= 99).length);
    const single = await caller.binnedSummary({ ...input, groups: 'echo_time', range: [epochDay(0), epochDay(0) + 0.5] });
    expect(single.buckets[0]).toMatchObject({ group: '0.03', n: 1 });
  });

  it('executes the shared statement on a study table with local column validation', async () => {
    const compiled = compileFiltersCore([], [
      { metric: asColumnId('local_metric'), range: [1, 10] },
      { metric: asColumnId('local_second'), range: [2, 5] },
    ], { field: () => { throw new Error('no fields'); }, metric: id => id });
    const rows = await fixture.db.withRead(async c => {
      await c.exec('CREATE TEMP TABLE study_time(created_at TIMESTAMP, local_metric DOUBLE, local_second DOUBLE)');
      await c.exec("INSERT INTO study_time VALUES ('2020-01-02',1,2),('2020-01-30',9,5),('2020-02-01',8,6),(NULL,3,4)");
      try {
        return await c.all(fill(loadTemplate('binned_summary', 'buckets'), {
          table: 'study_time', x: continuousAxisExpr(asColumnId('created_at'), 'time'), y: 'local_metric', where: compiled.where,
          ...binnedSummaryFragments('month'), group_expr: 'NULL::VARCHAR', group_numeric: 'FALSE', group_bins: '10', max_groups: '50',
        }), [...compiled.params, epochDay(0), epochDay(60), 1]);
      } finally { await c.exec('DROP TABLE study_time'); }
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.['n'])).toBe(2);
    expect(rows[0]?.['qs']).toEqual([1.4, 3, 5, 7, 8.6]);
  });

  it.each([
    { y: 'bad' }, { y: 'manufacturer' }, { y: 'created_at); DROP TABLE raw_bold; --' },
    { x: 'bad' }, { x: 'fd_mean); DROP TABLE raw_bold; --', bins: 10 }, { modality: 'T1w' }, { view: 'k3pp' }, { groups: 'created_at' },
    { groups: 'id' }, { groups: 'fd_mean' }, { bins: 'quarter' }, { bins: 10 }, { x: 'fd_mean', bins: 'month' },
    { range: ['bad', 1] }, { range: [2, 1] }, { range: [0] }, { range: [0, 0] },
    { selections: [{ metric: 'fd_mean', range: [2, 1] }] },
    { selections: [{ metric: 'cjv', range: [0, 1] }] },
  ])('rejects invalid input %j', async extra => {
    await expect(caller.binnedSummary({ ...input, ...extra } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
