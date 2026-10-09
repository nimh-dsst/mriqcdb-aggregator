import type { BinnedSummaryResult } from '@mriqc/shared';

type Bucket = BinnedSummaryResult['buckets'][number];
const probabilities = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Invert a count-weighted mixture of interpolated quantile CDFs. This fallback
 * for unions the API cannot express is always labelled approximate in the UI.
 * Counts and means remain exact; group medians are never averaged.
 */
export function approximateTimeTail(buckets: readonly Bucket[]): BinnedSummaryResult {
  const dates = new Map<string, Bucket[]>();
  for (const bucket of buckets) dates.set(String(bucket.lo), [...(dates.get(String(bucket.lo)) ?? []), bucket]);
  return { xKind: 'time', yKind: 'metric', range: [Math.min(...buckets.map(b => b.lo)), Math.max(...buckets.map(b => b.hi))], buckets: [...dates].sort(([a], [b]) => Number(a) - Number(b)).map(([, entries]) => {
    const n = entries.reduce((sum, entry) => sum + entry.n, 0);
    const knots = entries.map(entry => [entry.quantiles.p05, entry.quantiles.p25, entry.quantiles.p50, entry.quantiles.p75, entry.quantiles.p95]);
    const cdf = (values: number[], x: number) => {
      if (x < values[0]) return 0;
      if (x >= values[4]) return 1;
      for (let i = 1; i < values.length; i++) if (x < values[i]) {
        return probabilities[i - 1] + (probabilities[i] - probabilities[i - 1]) * (x - values[i - 1]) / (values[i] - values[i - 1]);
      }
      return 1;
    };
    const quantile = (p: number) => {
      let lo = Math.min(...knots.map(values => values[0])), hi = Math.max(...knots.map(values => values[4]));
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const count = entries.reduce((sum, entry, index) => sum + entry.n * cdf(knots[index], mid), 0);
        if (count < n * p) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    return { start: entries[0].start, lo: entries[0].lo, hi: entries[0].hi, group: 'Other', isOther: true, n, thin: n < 20,
      mean: entries.reduce((sum, entry) => sum + entry.n * entry.mean, 0) / n,
      quantiles: { p05: quantile(0.05), p25: quantile(0.25), p50: quantile(0.5), p75: quantile(0.75), p95: quantile(0.95) } };
  }) };
}
