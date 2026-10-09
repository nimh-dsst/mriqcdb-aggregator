import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Modality, View } from '@mriqc/shared';
import { metricsFor } from '@mriqc/shared';
import { Db, QueryTimeoutError } from '../db/instance.js';
import { tableFor } from '../db/views.js';
import { ANALYSIS_METRICS, RAW_ROWS, analysisValues, makeFixture, manufacturerOf, quantileCont, type Fixture } from '../testing/fixture.js';
import { createCaller } from './router.js';

let dir: string;
let fixture: Fixture;
let caller: ReturnType<typeof createCaller>;
const scope = { modality: 'bold' as const, view: 'raw' as const, filters: [] };
const density = { ...scope, x: 'fwhm_x', y: 'fwhm_y', bins: 10, clip: 'none' as const, sampleSize: 0 };
const matrix = { ...scope, metrics: [...ANALYSIS_METRICS], method: 'both' as const };
const rows = Array.from({ length: RAW_ROWS }, (_, i) => analysisValues(i));
const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** Pearson with centered sums, independent of DuckDB's online aggregate. */
function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = x.reduce((sum, v) => sum + v, 0) / x.length;
  const my = y.reduce((sum, v) => sum + v, 0) / y.length;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i]! - mx, dy = y[i]! - my;
    xy += dx * dy; xx += dx * dx; yy += dy * dy;
  }
  return xy / Math.sqrt(xx * yy);
}

/** Average tied ranks on just this metric's finite set, retaining row positions. */
function ranks(values: readonly (number | null)[]): Array<number | null> {
  const order = values.map((v, i) => ({ v, i })).filter((p) => finite(p.v)).sort((a, b) => a.v! - b.v!);
  const result = new Array<number | null>(values.length).fill(null);
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && order[end]!.v === order[start]!.v) end += 1;
    for (let k = start; k < end; k += 1) result[order[k]!.i] = (start + end + 1) / 2;
    start = end;
  }
  return result;
}

function pairs(source: readonly (readonly (number | null)[])[], a = 0, b = 1): [number[], number[]] {
  const kept = source.filter((row) => finite(row[a]) && finite(row[b]));
  return [kept.map((row) => row[a]!), kept.map((row) => row[b]!)];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-analysis-'));
  fixture = await makeFixture(dir);
  caller = createCaller({ db: fixture.db });
  // These fixture policies admit every even row. Their _all fixtures add the
  // odd raw rows, exactly once, and include canonical-only NULL columns there.
  await fixture.db.withWriter(async (c) => {
    for (const modality of ['bold', 'T1w', 'T2w'] as const) {
      const view = modality === 'bold' ? 'k4plus' : 'k3pp';
      const raw = tableFor(modality, 'raw');
      const canon = tableFor(modality, view);
      await c.exec(`CREATE VIEW ${tableFor(modality, `${view}_all`)} AS
        SELECT * FROM ${canon} UNION ALL BY NAME
        SELECT * FROM ${raw} WHERE CAST(right(id, 4) AS INTEGER) % 2 = 1`);
    }
  });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('density2d', () => {
  it('returns time grids and samples in days since 2000-01-01 with independent counts and correlations', async () => {
    const epoch = (Date.UTC(2020, 0, 1) - Date.UTC(2000, 0, 1)) / 86_400_000;
    const result = await caller.density2d({ ...density, x: 'created_at', y: 'fwhm_y', sampleSize: 47,
      range: { x: [epoch + 30, epoch + 230], y: [10, 150] } });
    const pairs = rows.map((row, i) => [epoch + i, row[1]] as const).filter(pair => finite(pair[1]));
    const expected = new Array<number>(100).fill(0);
    const tails = [0, 0, 0, 0];
    for (const [x, yValue] of pairs) {
      const y = yValue!;
      if (x < epoch + 30) tails[0]! += 1;
      else if (x > epoch + 230) tails[1]! += 1;
      else if (y < 10) tails[2]! += 1;
      else if (y > 150) tails[3]! += 1;
      else expected[Math.min(9, Math.floor((y - 10) / 14)) * 10 + Math.min(9, Math.floor((x - epoch - 30) / 20))]! += 1;
    }
    expect(result.xKind).toBe('time');
    expect(result.x).toMatchObject({ lo: epoch + 30, width: 20 });
    expect(result.n).toBe(pairs.length);
    expect(result.counts).toEqual(expected);
    expect([result.x.underflow, result.x.overflow, result.y.underflow, result.y.overflow]).toEqual(tails);
    expect(result.pearson).toBeCloseTo(pearson(pairs.map(p => p[0]), pairs.map(p => p[1]!)), 9);
    expect(result.sample).toHaveLength(47);
    expect(result.sample.every(([x, y]) => Number.isInteger(x) && x >= epoch + 30 && x <= epoch + 230 && y >= 10 && y <= 150)).toBe(true);
    expect((await caller.density2d(density)).xKind).toBe('metric');
  });

  it.each(['unknown', 'created_at); DROP TABLE raw_bold; --', 'manufacturer'])('rejects noncontinuous or unknown x %s', async x => {
    await expect(caller.density2d({ ...density, x })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('matches independent Pearson and tied Spearman on finite pairs to 1e-9', async () => {
    const result = await caller.density2d(density);
    const [x, y] = pairs(rows);
    expect(result.n).toBe(2640);
    expect(Math.abs(result.pearson! - pearson(x, y))).toBeLessThan(1e-9);
    expect(Math.abs(result.spearman! - pearson(ranks(x) as number[], ranks(y) as number[]))).toBeLessThan(1e-9);
    expect(result.counts.reduce((sum, v) => sum + v, 0)).toBe(result.n);
  });

  it('finds perfect rank correlation in the nonlinear pair', async () => {
    const result = await caller.density2d({ ...density, y: 'fwhm_z' });
    const [x, y] = pairs(rows, 0, 2);
    expect(result.spearman).toBeCloseTo(1, 12);
    expect(Math.abs(result.pearson! - pearson(x, y))).toBeLessThan(1e-9);
    expect(result.pearson).toBeLessThan(0.99);
  });

  it('uses row-major bins, inclusive endpoints, and disjoint tails that conserve n', async () => {
    const range = { x: [100, 900] as [number, number], y: [400, 1400] as [number, number] };
    const result = await caller.density2d({ ...density, range });
    const expected = new Array<number>(100).fill(0);
    const tails = [0, 0, 0, 0];
    for (const row of rows) {
      const [x, y] = row;
      if (!finite(x) || !finite(y)) continue;
      if (x < 100) tails[0]! += 1;
      else if (x > 900) tails[1]! += 1;
      else if (y < 400) tails[2]! += 1;
      else if (y > 1400) tails[3]! += 1;
      else expected[Math.min(9, Math.floor((y - 400) / 100)) * 10 + Math.min(9, Math.floor((x - 100) / 80))]! += 1;
    }
    expect(result.counts).toEqual(expected);
    expect([result.x.underflow, result.x.overflow, result.y.underflow, result.y.overflow]).toEqual(tails);
    expect(expected.reduce((a, b) => a + b, 0) + tails.reduce((a, b) => a + b, 0)).toBe(result.n);
  });

  it.each(['p01p99', 'p05p95', 'none'] as const)('derives %s edges from finite pairs', async (clip) => {
    const result = await caller.density2d({ ...density, clip });
    const [x, y] = pairs(rows);
    const q = clip === 'p01p99' ? 0.01 : clip === 'p05p95' ? 0.05 : 0;
    for (const [axis, values] of [[result.x, x], [result.y, y]] as const) {
      const sorted = [...values].sort((a, b) => a - b);
      expect(axis.lo).toBeCloseTo(quantileCont(sorted, q), 10);
      expect(axis.width).toBeCloseTo((quantileCont(sorted, 1 - q) - axis.lo) / 10, 10);
    }
    expect(result.counts.reduce((a, b) => a + b, 0) + result.x.underflow + result.x.overflow + result.y.underflow + result.y.overflow).toBe(result.n);
  });

  it('retains identical explicit edges across cohorts, including an empty cohort', async () => {
    const range = { x: [100, 800] as [number, number], y: [300, 1500] as [number, number] };
    const outputs = await Promise.all(['Siemens', 'GE', 'missing'].map((vendor) => caller.density2d({
      ...density, range, filters: [{ field: 'manufacturer', op: 'in', values: [vendor] }],
    })));
    for (const result of outputs) {
      expect(result.x).toMatchObject({ lo: 100, width: 70, bins: 10 });
      expect(result.y).toMatchObject({ lo: 300, width: 120, bins: 10 });
    }
    expect(outputs[2]).toMatchObject({ n: 0, pearson: null, spearman: null, sample: [] });
    expect(outputs[2]!.counts).toEqual(new Array(100).fill(0));
  });

  it('bounds samples, repeats a seed, and changes the draw for another seed', async () => {
    const request = { ...density, sampleSize: 37, range: { x: [100, 700] as [number, number], y: [300, 1200] as [number, number] } };
    const [a, b, other] = await Promise.all([
      caller.density2d(request), caller.density2d({ ...request, seed: 1 }), caller.density2d({ ...request, seed: 2 }),
    ]);
    expect(a.sample).toHaveLength(37);
    expect(a.sample).toEqual(b.sample);
    expect(a.sample).not.toEqual(other.sample);
    for (const [x, y] of a.sample) {
      expect(finite(x) && finite(y) && x >= 100 && x <= 700 && y >= 300 && y <= 1200).toBe(true);
    }
    const big = await caller.density2d({ ...density, sampleSize: 20_000 });
    expect(big.sample).toHaveLength(big.n);
    expect(big.sample.length).toBeLessThanOrEqual(20_000);
  });

  it('handles zero samples, singleton/constant axes, and defaults', async () => {
    const one = await caller.density2d({ ...density, selection: { metric: 'fd_mean', range: [0, 0] } });
    expect(one).toMatchObject({ n: 1, pearson: null, spearman: null, sample: [] });
    expect(one.x.width).toBe(0);
    expect(one.counts[0]).toBe(1);
    const defaults = await caller.density2d({ ...scope, x: 'fwhm_x', y: 'fwhm_z' });
    expect(defaults.counts).toHaveLength(120 * 120);
    expect(defaults.sample).toHaveLength(2000);
  });

  it('honours filters and selection on the same finite population', async () => {
    const result = await caller.density2d({ ...density,
      filters: [{ field: 'manufacturer', op: 'in', values: ['Siemens'] }],
      selection: { metric: 'fwhm_z', range: [100, 10_000] },
    });
    const selected = rows.filter((r, i) => manufacturerOf(i) === 'Siemens' && finite(r[2]) && r[2] >= 100 && r[2] <= 10_000);
    const [x, y] = pairs(selected);
    expect(result.n).toBe(x.length);
    expect(Math.abs(result.pearson! - pearson(x, y))).toBeLessThan(1e-9);
  });

  it('repeats the reservoir sample across parallel scans of multiple row groups', async () => {
    const db = new Db(':memory:', 2);
    try {
      await db.withWriter(async (c) => {
        await c.exec('SET threads = 4');
        await c.exec(`CREATE TABLE raw_bold AS SELECT i::DOUBLE AS fwhm_x,
          (i * i)::DOUBLE AS fwhm_y FROM range(300000) t(i)`);
      });
      const concurrent = createCaller({ db });
      const request = { ...density, sampleSize: 2000, seed: 77 };
      const a = await concurrent.density2d(request);
      const [b, c] = await Promise.all([concurrent.density2d(request), concurrent.density2d(request)]);
      expect(a.n).toBe(300_000);
      expect(a.sample).toHaveLength(2000);
      expect(b.sample).toEqual(a.sample);
      expect(c.sample).toEqual(a.sample);
      const settings = await db.withRead((connection) => connection.all("SELECT current_setting('threads') AS n"));
      expect(Number(settings[0]!['n'])).toBe(4);
    } finally { await db.close(); }
  });
});

describe('correlation', () => {
  it('matches reference pairwise deletion, per-metric average ranks, counts and order', async () => {
    const order = [2, 0, 1];
    const result = await caller.correlation({ ...matrix, metrics: order.map((i) => ANALYSIS_METRICS[i]!) });
    expect(result.metrics).toEqual(order.map((i) => ANALYSIS_METRICS[i]));
    const ranked = ANALYSIS_METRICS.map((_, i) => ranks(rows.map((r) => r[i]!)));
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) {
      const i = order[a]!, j = order[b]!;
      const [x, y] = pairs(rows, i, j);
      const [rx, ry] = pairs(rows.map((_, k) => [ranked[i]![k]!, ranked[j]![k]!]));
      expect(result.pairN[a]![b]).toBe(x.length);
      expect(Math.abs(result.pearson![a]![b]! - pearson(x, y))).toBeLessThan(1e-9);
      expect(Math.abs(result.spearman![a]![b]! - pearson(rx, ry))).toBeLessThan(1e-9);
      expect(result.pearson![a]![b]).toBe(result.pearson![b]![a]);
      expect(result.spearman![a]![b]).toBe(result.spearman![b]![a]);
      if (a === b) {
        expect(result.pearson![a]![b]).toBeCloseTo(1, 12);
        expect(result.spearman![a]![b]).toBeCloseTo(1, 12);
      }
    }
    expect(result.minPairN).toBe(2640);
    // Ranking each metric before pairwise deletion differs from pair-specific ranks.
    const paired = await caller.density2d({ ...density, y: 'fwhm_z' });
    expect(Math.abs(result.spearman![0]![1]! - paired.spearman!)).toBeGreaterThan(1e-9);
  });

  it.each(['pearson', 'spearman'] as const)('returns only the requested %s matrix', async (method) => {
    const result = await caller.correlation({ ...matrix, method });
    expect(result[method]).toHaveLength(3);
    expect(result[method === 'pearson' ? 'spearman' : 'pearson']).toBeUndefined();
  });

  it('uses filters and selection before ranking', async () => {
    const result = await caller.correlation({ ...matrix,
      filters: [{ field: 'manufacturer', op: 'in', values: ['GE'] }],
      selection: { metric: 'fwhm_z', range: [100, 40_000] },
    });
    const selected = rows.filter((r, i) => manufacturerOf(i) === 'GE' && finite(r[2]) && r[2] >= 100 && r[2] <= 40_000);
    const columns = ANALYSIS_METRICS.map((_, i) => ranks(selected.map((r) => r[i]!)));
    const [rx, ry] = pairs(selected.map((_, k) => [columns[0]![k]!, columns[1]![k]!]));
    expect(result.pairN[0]![1]).toBe(rx.length);
    expect(Math.abs(result.spearman![0]![1]! - pearson(rx, ry))).toBeLessThan(1e-9);
  });

  it('returns zero pair counts and undefined coefficients for an empty cohort', async () => {
    const result = await caller.correlation({ ...matrix, filters: [{ field: 'manufacturer', op: 'in', values: ['missing'] }] });
    expect(result.minPairN).toBe(0);
    expect(result.pairN.flat()).toEqual(new Array(9).fill(0));
    expect(result.pearson!.flat().every(Number.isNaN)).toBe(true);
    expect(result.spearman!.flat().every(Number.isNaN)).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).pearson).toEqual(Array.from({ length: 3 }, () => [null, null, null]));
  });
});

const views: Array<[Modality, View]> = [
  ['bold', 'raw'], ['bold', 'k4plus'], ['bold', 'k4plus_all'],
  ['T1w', 'raw'], ['T1w', 'k3pp'], ['T1w', 'k3pp_all'],
  ['T2w', 'raw'], ['T2w', 'k3pp'], ['T2w', 'k3pp_all'],
];
it.each(views)('runs both procedures on %s/%s', async (modality, view) => {
  const d = await caller.density2d({ ...density, modality, view });
  const c = await caller.correlation({ ...matrix, modality, view });
  const subset = view.endsWith('_all') || view === 'raw' ? rows : rows.filter((_, i) => i % 2 === 0);
  expect(d.n).toBe(pairs(subset)[0].length);
  expect(c.pairN[0]![1]).toBe(d.n);
});

describe('analysis validation and execution', () => {
  it.each([
    { y: 'fwhm_x' }, { x: 'cjv' }, { x: 'unknown' }, { bins: 9 }, { bins: 201 }, { bins: 10.5 },
    { sampleSize: -1 }, { sampleSize: 20_001 }, { seed: -1 }, { seed: 1.5 }, { seed: 2 ** 31 },
    { range: { x: [1, 1], y: [0, 1] } }, { range: { x: [0, Infinity], y: [0, 1] } },
    { range: { x: [0, 1], y: [2, 1] } }, { range: { x: [0, 1] } },
    { view: 'k3pp' }, { selection: { metric: 'cjv', range: [0, 1] } },
  ])('rejects invalid density input %j', async (bad) => {
    await expect(caller.density2d({ ...density, ...bad } as Parameters<typeof caller.density2d>[0])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each([
    { metrics: ['fwhm_x'] }, { metrics: ['fwhm_x', 'fwhm_x'] }, { metrics: ['fwhm_x', 'cjv'] },
    { metrics: metricsFor('bold').slice(0, 25).map((m) => m.id) }, { method: 'invalid' },
    { filters: [{ field: 'id', op: 'in', values: ['x'] }] },
  ])('rejects invalid correlation input %j', async (bad) => {
    await expect(caller.correlation({ ...matrix, ...bad } as Parameters<typeof caller.correlation>[0])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('uses one pooled read/deadline per call', async () => {
    const reads = vi.spyOn(fixture.db, 'withRead');
    try {
      await caller.density2d({ ...density, sampleSize: 20 });
      expect(reads).toHaveBeenCalledTimes(1);
      await caller.correlation(matrix);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally { reads.mockRestore(); }
  });

  it('maps the existing timeout shape for both procedures', async () => {
    const reads = vi.spyOn(fixture.db, 'withRead').mockRejectedValue(new QueryTimeoutError(1));
    try {
      await expect(caller.density2d(density)).rejects.toMatchObject({ code: 'TIMEOUT' });
      await expect(caller.correlation(matrix)).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally { reads.mockRestore(); }
  });
});
