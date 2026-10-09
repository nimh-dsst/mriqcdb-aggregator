import type { BinnedSummaryResult,CoverageResult,Granularity } from '@mriqc/shared';

/**
 * A band over upload counts. Counts are taken per fine period (a day, or a
 * month when the panel bins by year), and each panel bin shows the median
 * fine-period count with the spread of those counts around it. A month of
 * steady uploads draws a tight band; a month with one large dump, a tall one.
 *
 * Fine periods with no uploads are zeros, not gaps: a quiet day is part of
 * the spread. Periods after the last upload are left out, so the current,
 * unfinished bin is not dragged down by days that have not happened yet.
 */

const DAY = 86_400_000;
const EPOCH = Date.UTC(2000, 0, 1);

/** The period counted inside each panel bin. */
export function fineGranularity(coarse: Granularity): Granularity {
  return coarse === 'year' ? 'month' : 'day';
}

const parseStart = (start: string): number => {
  const iso = start.includes('T') ? start : start.replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
};

/** Start of the period containing `time`, the way DuckDB's date_trunc cuts it (weeks start Monday). */
export function truncate(time: number, unit: Granularity): number {
  const date = new Date(time);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  switch (unit) {
    case 'year': return Date.UTC(year, 0, 1);
    case 'month': return Date.UTC(year, month, 1);
    case 'week': return Date.UTC(year, month, day - ((date.getUTCDay() + 6) % 7));
    case 'day': return Date.UTC(year, month, day);
  }
}

function next(time: number, unit: Granularity): number {
  const date = new Date(time);
  switch (unit) {
    case 'year': return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
    case 'month': return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    case 'week': return time + 7 * DAY;
    case 'day': return time + DAY;
  }
}

/** Linear-interpolated quantile of an ascending list. */
function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export function countBand(coverage: CoverageResult, coarse: Granularity): BinnedSummaryResult {
  const fine = fineGranularity(coarse);

  // Coverage is split by its group column; a band counts every group together.
  const counts = new Map<number, number>();
  for (const bucket of coverage.buckets) {
    const start = truncate(parseStart(bucket.start), fine);
    if (Number.isFinite(start)) counts.set(start, (counts.get(start) ?? 0) + bucket.n);
  }
  if (!counts.size) return { xKind: 'time', yKind: 'metric', range: [0, 0], buckets: [] };

  const first = Math.min(...counts.keys());
  const last = Math.max(...counts.keys());
  const bins = new Map<number, number[]>();
  for (let period = first; period <= last; period = next(period, fine)) {
    const bin = truncate(period, coarse);
    const list = bins.get(bin) ?? [];
    list.push(counts.get(period) ?? 0);
    bins.set(bin, list);
  }

  const days = (time: number) => (time - EPOCH) / DAY;
  const buckets = [...bins].sort(([a], [b]) => a - b).map(([bin, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      lo: days(bin),
      hi: days(next(bin, coarse)),
      start: new Date(bin).toISOString(),
      group: null,
      isOther: false,
      n: total,
      thin: false,
      mean: total / values.length,
      quantiles: {
        p05: quantile(sorted, 0.05),
        p25: quantile(sorted, 0.25),
        p50: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        p95: quantile(sorted, 0.95),
      },
    };
  });

  return {
    xKind: 'time',
    yKind: 'metric',
    range: [buckets[0].lo, buckets.at(-1)!.hi],
    buckets,
  };
}
