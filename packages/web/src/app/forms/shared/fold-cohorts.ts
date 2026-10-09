import type { DistributionResult, Quantiles } from '@mriqc/shared';
import type { Cohort } from '../../graph/state';
import type { CohortResult } from './rows';
import { MAX_CATEGORIES } from './palette';

export const OTHER_COHORT = 'display:other';

/** Pool memberships on the shared grid. Overlapping cohorts deliberately retain
 * their repeated memberships; a union cannot be recovered from summary results.
 * Quantiles are estimates interpolated within bins, never averages of quantiles.
 */
export function pooledDistribution(
  results: readonly DistributionResult[],
): DistributionResult | null {
  if (results.length === 0) return null;
  const grid = results[0].histogram;
  if (
    results.some(
      ({ histogram: h }) =>
        h.lo !== grid.lo || h.hi !== grid.hi || h.counts.length !== grid.counts.length,
    )
  )
    return null;
  const n = results.reduce((sum, r) => sum + r.n, 0);
  const counts = grid.counts.map((_, i) =>
    results.reduce((sum, r) => sum + r.histogram.counts[i], 0),
  );
  const underflow = results.reduce((sum, r) => sum + (r.histogram.underflow ?? 0), 0);
  const overflow = results.reduce((sum, r) => sum + (r.histogram.overflow ?? 0), 0);
  const min = Math.min(...results.flatMap((r) => (r.min === null ? [] : [r.min])));
  const max = Math.max(...results.flatMap((r) => (r.max === null ? [] : [r.max])));
  const mean =
    n > 0 && results.every((r) => r.n === 0 || r.mean !== null)
      ? results.reduce((sum, r) => sum + r.n * (r.mean ?? 0), 0) / n
      : null;
  const stddev =
    mean !== null && n > 1 && results.every((r) => r.n <= 1 || r.stddev !== null)
      ? Math.sqrt(
          results.reduce(
            (sum, r) =>
              sum +
              Math.max(0, r.n - 1) * (r.stddev ?? 0) ** 2 +
              r.n * ((r.mean ?? mean) - mean) ** 2,
            0,
          ) /
            (n - 1),
        )
      : null;
  // A clipped tail does not locate an interior quantile: leave the box/quantile
  // cells unavailable if any of their seven targets falls outside the grid.
  const quantile = (p: number): number | null => {
    const target = p * n;
    if (target < underflow || target > n - overflow) return null;
    let cumulative = underflow;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0 && cumulative + counts[i] >= target)
        return grid.lo + (i + (target - cumulative) / counts[i]) * grid.width;
      cumulative += counts[i];
    }
    return grid.hi;
  };
  const entries = [1, 5, 25, 50, 75, 95, 99].map(
    (p) => [`p${String(p).padStart(2, '0')}`, quantile(p / 100)] as const,
  );
  const quantiles =
    n > 0 && entries.every(([, q]) => q !== null)
      ? (Object.fromEntries(entries) as unknown as Quantiles)
      : null;
  return {
    n,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean,
    stddev,
    quantiles,
    histogram: { ...grid, counts, underflow, overflow },
  };
}

/** Six largest cohorts retain their identities; the rest form one grey tail. */
export function foldCohorts(cohorts: readonly Cohort[], results: readonly CohortResult[]) {
  if (cohorts.length <= MAX_CATEGORIES) return { cohorts, results, folded: false };
  const ranked = cohorts
    .map((cohort, i) => ({ cohort, result: results[i], i }))
    .sort((a, b) => (b.result?.base?.n ?? -1) - (a.result?.base?.n ?? -1) || a.i - b.i);
  const keep = new Set(ranked.slice(0, MAX_CATEGORIES).map((entry) => entry.i));
  const kept = cohorts
    .map((cohort, i) => ({ cohort, result: results[i], i }))
    .filter((entry) => keep.has(entry.i));
  const tail = ranked.slice(MAX_CATEGORIES);
  const ranged = tail.every((entry) => entry.result?.ranged != null)
    ? pooledDistribution(tail.map((entry) => entry.result.ranged!))
    : null;
  const other: Cohort = {
    ...tail[0].cohort,
    id: OTHER_COHORT,
    name: 'Other',
    color: MAX_CATEGORIES,
  };
  return {
    cohorts: [...kept.map((entry) => entry.cohort), other],
    results: [
      ...kept.map((entry) => entry.result),
      { id: OTHER_COHORT, name: 'Other', base: ranged, ranged },
    ],
    folded: true,
  };
}
