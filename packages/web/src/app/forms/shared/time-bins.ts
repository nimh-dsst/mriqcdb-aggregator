import type { CoverageResult, DistributionResult, Granularity, MetricSummary } from "@mriqc/shared";

export interface CoverageBin {
  lo: number;
  hi: number;
  count: number;
}

const QUANTILE_NAMES = ["p01", "p05", "p25", "p50", "p75", "p95", "p99"] as const;
const QUANTILE_PROBABILITIES = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99] as const;

function nextUtcBucketStart(start: number, granularity: Granularity): number {
  const date = new Date(start);
  const unit = granularity as unknown as string;

  switch (unit) {
    case "day":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    case "week":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 7);
    case "month":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    case "year":
      return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
    default:
      throw new Error(`Unsupported coverage granularity: ${unit}`);
  }
}

/**
 * Converts coverage buckets into contiguous UTC calendar intervals. Missing
 * intervals between returned buckets are represented with a zero count.
 */
export function coverageBins(
  result: CoverageResult | null,
  granularity: Granularity,
): CoverageBin[] {
  const countsByStart = new Map<number, number>();

  for (const bucket of result?.buckets ?? []) {
    const start = new Date(bucket.start).getTime();
    if (Number.isNaN(start)) {
      continue;
    }

    countsByStart.set(start, (countsByStart.get(start) ?? 0) + bucket.n);
  }

  const starts = [...countsByStart.keys()].sort((left, right) => left - right);
  if (starts.length === 0) {
    return [];
  }

  const lastStart = starts.at(-1)!;
  const bins: CoverageBin[] = [];
  let start = starts[0];

  while (start <= lastStart) {
    const hi = nextUtcBucketStart(start, granularity);
    if (!Number.isFinite(hi) || hi <= start) {
      break;
    }

    bins.push({ lo: start, hi, count: countsByStart.get(start) ?? 0 });
    start = hi;
  }

  return bins;
}

/**
 * Represents each calendar bucket by its index midpoint, preserving the
 * unequal real-world duration of months and years for display mapping.
 */
export function coverageDistribution(
  result: CoverageResult | null,
  granularity: Granularity,
): DistributionResult {
  const bins = coverageBins(result, granularity);
  const counts = bins.map((bin) => bin.count);
  const n = counts.reduce((total, count) => total + count, 0);
  const occupied = counts
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count > 0);

  if (n <= 0 || occupied.length === 0) {
    return {
      n,
      min: null,
      max: null,
      mean: null,
      stddev: null,
      quantiles: null,
      histogram: { lo: 0, hi: counts.length, width: 1, counts },
    };
  }

  const mean = counts.reduce((total, count, index) => total + count * (index + 0.5), 0) / n;
  const variance = counts.reduce(
    (total, count, index) => total + count * (index + 0.5 - mean) ** 2,
    0,
  ) / n;
  const quantiles = {} as Record<(typeof QUANTILE_NAMES)[number], number>;
  let cumulative = 0;
  let quantileIndex = 0;

  for (let index = 0; index < counts.length && quantileIndex < QUANTILE_NAMES.length; index += 1) {
    cumulative += counts[index];

    while (
      quantileIndex < QUANTILE_NAMES.length &&
      cumulative >= QUANTILE_PROBABILITIES[quantileIndex] * n
    ) {
      quantiles[QUANTILE_NAMES[quantileIndex]] = index + 0.5;
      quantileIndex += 1;
    }
  }

  return {
    n,
    min: occupied[0].index + 0.5,
    max: occupied.at(-1)!.index + 0.5,
    mean,
    stddev: Math.sqrt(variance),
    quantiles: quantiles as MetricSummary["quantiles"],
    histogram: { lo: 0, hi: counts.length, width: 1, counts },
  };
}

/** Maps a histogram coordinate back to a UTC millisecond timestamp. */
export function timeBinValue(bins: CoverageBin[], value: number): number {
  if (!Number.isFinite(value) || bins.length === 0 || value < 0 || value > bins.length) {
    return Number.NaN;
  }

  if (value === bins.length) {
    return bins.at(-1)!.hi;
  }

  const index = Math.floor(value);
  const bin = bins[index];
  return bin.lo + (value - index) * (bin.hi - bin.lo);
}
