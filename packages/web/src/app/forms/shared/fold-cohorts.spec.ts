import type { DistributionResult } from '@mriqc/shared';
import type { Cohort } from '../../graph/state';
import { foldCohorts, pooledDistribution } from './fold-cohorts';

const distribution = (n: number): DistributionResult => ({
  n,
  min: 0,
  max: 2,
  mean: 1,
  stddev: 0.5,
  quantiles: { p01: 0.02, p05: 0.1, p25: 0.5, p50: 1, p75: 1.5, p95: 1.9, p99: 1.98 },
  histogram: { lo: 0, hi: 2, width: 1, counts: [n / 2, n / 2], underflow: 0, overflow: 0 },
});

describe('comparison folding', () => {
  it('keeps the largest six, pools every remaining cohort once, and puts Other last', () => {
    const cohorts = Array.from({ length: 9 }, (_, i): Cohort => ({
      id: `c${i}`,
      name: `C${i}`,
      color: i,
      source: 'population',
      view: 'raw',
      filters: [],
      selections: [],
    }));
    const results = cohorts.map((c, i) => ({
      id: c.id,
      name: c.name,
      base: distribution(i + 1),
      ranged: distribution(i + 1),
    }));
    const folded = foldCohorts(cohorts, results);
    expect(folded.cohorts.map((c) => c.name)).toEqual([
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'Other',
    ]);
    expect(folded.results.at(-1)?.ranged?.n).toBe(6);
    expect(folded.results.at(-1)?.ranged?.histogram.counts).toEqual([3, 3]);
    expect(folded.results.reduce((n, r) => n + (r.base?.n ?? 0), 0)).toBe(45);
  });
  it('interpolates pooled quantiles from mass and refuses mismatched grids', () => {
    const pooled = pooledDistribution([distribution(10), distribution(30)]);
    expect(pooled?.quantiles?.p50).toBe(1);
    expect(pooled?.mean).toBe(1);
    expect(pooled?.n).toBe(40);
    expect(
      pooledDistribution([
        distribution(10),
        { ...distribution(30), histogram: { lo: 0, hi: 4, width: 2, counts: [15, 15] } },
      ]),
    ).toBeNull();
  });
  it('waits for every tail result instead of drawing a partial Other', () => {
    const cohorts = Array.from({ length: 7 }, (_, i): Cohort => ({
      id: `c${i}`,
      name: `C${i}`,
      color: i,
      source: 'population',
      view: 'raw',
      filters: [],
      selections: [],
    }));
    const results = cohorts.map((c) => ({
      id: c.id,
      name: c.name,
      base: distribution(1),
      ranged: null,
    }));
    expect(foldCohorts(cohorts, results).results.at(-1)?.base).toBeNull();
  });
});
