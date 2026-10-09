/**
 * Procedure results turned into the flat rows the specs encode. Pure, and
 * separate from the specs so a chart type can change its encoding without
 * touching the wire shape, and vice versa.
 */

import type {
  ClipMode,
  CoverageResult,
  DistributionResult,
  GroupSummary,
  GroupedSummaryResult,
  Histogram,
  MetricSummary,
  Quantiles,
} from '@mriqc/shared';
import { fieldValueLabel } from '@mriqc/shared';
import { densityPoints, type DensityPoint } from '../../slices/series/comparison-stats';

/** One bar of a histogram. */
export interface BinRow {
  lo: number;
  hi: number;
  count: number;
}

/** A histogram row prepared for the separate dominant-value spike treatment. */
export interface DegenerateBinRow extends BinRow {
  plotCount: number;
  spike: boolean;
  spikeLabel: string;
}

export interface DegenerateSpike {
  index: number;
  value: number;
  count: number;
  share: number;
}

/** One step of an ECDF. */
export interface EcdfRow {
  value: number;
  p: number;
}

/** One group's box, already reduced to the five numbers the marks need. */
export interface BoxRow {
  group: string;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  n: number;
}

/** A facet row: a bin, tagged with its group. */
export type GroupedBinRow = BinRow & { group: string; facet: string };

/** A facet row: an ECDF step, tagged with its group. */
export type GroupedEcdfRow = EcdfRow & { group: string; facet: string };

/** One coverage cell. */
export interface CoverageRow {
  start: string;
  group: string;
  n: number;
}

/**
 * The x range a `clip` mode asks for, from the quantiles the server already
 * sent.
 *
 * `distribution` clips server-side -- `clip` is part of its input and of the
 * query key, because the histogram is binned over the clipped range. What is
 * left here is the client-side clipping the server cannot do: `groupedSummary`
 * takes no `clip`, and an ECDF's quantile points come from the unclipped
 * summary even when its histogram was clipped.
 */
export function clipBounds(
  summary: MetricSummary,
  clip: ClipMode,
): readonly [number, number] | null {
  // Falsy and not `=== null`: the quantiles of a result that is not one -- an
  // entry whose `result` is `unknown` and came from somewhere unexpected -- are
  // `undefined`, and reading `.p01` off that throws. This is called from inside
  // query-key construction, which runs in the reducer's `evict`, so a throw here
  // would error the fold and stop the dashboard for good.
  if (clip === 'none' || !summary.quantiles) return null;
  const q = summary.quantiles;
  const [lo, hi] = clip === 'p05p95' ? [q.p05, q.p95] : [q.p01, q.p99];
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

/** Keep the bins that overlap the clip range. */
function clipBins(rows: BinRow[], bounds: readonly [number, number] | null): BinRow[] {
  if (!bounds) return rows;
  const [lo, hi] = bounds;
  return rows.filter((row) => row.hi > lo && row.lo < hi);
}

/** Keep the ECDF steps inside the clip range. */
function clipSteps(rows: EcdfRow[], bounds: readonly [number, number] | null): EcdfRow[] {
  if (!bounds) return rows;
  const [lo, hi] = bounds;
  return rows.filter((row) => row.value >= lo && row.value <= hi);
}

/**
 * How a null, boolean or numeric group value is written on an axis.
 *
 * "Not reported" for null and the empty string alike, which is what the filter
 * lists show: the dashboard had two names for one thing. `field` is the id of
 * the column being grouped on, so a field with names of its own -- motion
 * correction reads "AFNI (3dvolreg)", not `afni` -- gets them on the axis and
 * in the legend as well as in the filter list. The stored value is unchanged;
 * only the writing is.
 */
export function groupLabel(value: string | number | boolean | null, field?: string | null): string {
  const label = fieldValueLabel(field, value);
  return label === 'other' ? 'Other' : label;
}

/** Expand an equal-width histogram into one row per bin. */
export function binRows(histogram: Histogram | undefined): BinRow[] {
  if (!histogram || !Number.isFinite(histogram.width)) return [];
  return histogram.counts.map((count, i) => ({
    lo: histogram.lo + i * histogram.width,
    hi: histogram.lo + (i + 1) * histogram.width,
    count,
  }));
}

const QUANTILE_LEVELS: readonly (readonly [keyof Quantiles, number])[] = [
  ['p01', 0.01],
  ['p05', 0.05],
  ['p25', 0.25],
  ['p50', 0.5],
  ['p75', 0.75],
  ['p95', 0.95],
  ['p99', 0.99],
];

/** The share of the sample that lies below a clip mode's lower bound. */
const CLIPPED_BELOW: Record<ClipMode, number> = { none: 0, p01p99: 0.01, p05p95: 0.05 };

/**
 * An ECDF from the two things the server sends: the seven quantiles, which
 * pin the curve where it matters, and the cumulative histogram, which fills in
 * the shape between them. Points are merged and sorted by value.
 *
 * Both halves have to be on the same scale. `distribution` bins over the
 * clipped range, so its histogram counts only the rows inside `[lo, hi]` --
 * normalizing by the bin total would trace F restricted to that range, which
 * runs 0..1 between quantile points that run 0.01..0.99 and shows up as the
 * curve stepping backwards. Dividing by the full `n` and offsetting by the mass
 * the clip cut off puts both on the sample's own CDF.
 */
export function ecdfRows(
  summary: MetricSummary & { histogram?: Histogram },
  clip: ClipMode = 'none',
): EcdfRow[] {
  const points: EcdfRow[] = [];
  if (summary.quantiles) {
    for (const [key, p] of QUANTILE_LEVELS) {
      const value = summary.quantiles[key];
      if (Number.isFinite(value)) points.push({ value, p });
    }
  }
  const bins = binRows(summary.histogram);
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  if (total > 0) {
    // A histogram that already covers the whole sample needs no offset; one
    // that counts fewer rows than `n` was binned over a clipped range.
    const n = Number.isFinite(summary.n) ? summary.n : 0;
    const partial = n > total;
    const denominator = partial ? n : total;
    const below = partial ? (CLIPPED_BELOW[clip] ?? 0) : 0;
    let cumulative = 0;
    for (const bin of bins) {
      cumulative += bin.count;
      points.push({ value: bin.hi, p: below + cumulative / denominator });
    }
  }
  return clipSteps(
    points.sort((a, b) => a.value - b.value),
    clipBounds(summary, clip),
  );
}

/**
 * Distribution result to histogram rows. `clip` defaults to `'none'` because
 * the server already binned over the clipped range; it is still accepted for a
 * result that was not clipped server-side.
 */
export function distributionBins(result: DistributionResult, clip: ClipMode = 'none'): BinRow[] {
  return clipBins(binRows(result.histogram), clipBounds(result, clip));
}

/** Identify a majority exact value without mistaking an ordinary tall bin for one. */
export function degenerateSpike(result: DistributionResult): DegenerateSpike | null {
  if (result.n <= 0 || result.histogram.counts.length === 0) return null;
  let index = 0;
  for (let i = 1; i < result.histogram.counts.length; i += 1) {
    if (result.histogram.counts[i] > result.histogram.counts[index]) index = i;
  }
  const count = result.histogram.counts[index] ?? 0;
  if (count * 2 <= result.n) return null;
  const q = result.quantiles;
  const exact =
    result.histogram.width === 0 || result.histogram.counts.length === 1
      ? (q?.p50 ?? result.histogram.lo)
      : q !== null && (q.p25 === q.p50 || q.p50 === q.p75)
        ? q.p50
        : null;
  return exact === null || !Number.isFinite(exact)
    ? null
    : { index, value: exact, count, share: count / result.n };
}

/** Remove the majority bin and add a labelled spike beside the remaining histogram. */
export function degenerateHistogramRows(
  result: DistributionResult,
  spike: DegenerateSpike,
): DegenerateBinRow[] {
  const bins = distributionBins(result);
  const remaining = bins.filter((_, index) => index !== spike.index);
  const remainingMax = Math.max(1, ...remaining.map((row) => row.count));
  const width =
    result.histogram.width > 0 ? result.histogram.width : Math.max(Math.abs(spike.value) * 0.02, 1);
  const left = bins.length > 0 ? bins[0].lo : spike.value;
  const normal = remaining.map((row) => ({
    ...row,
    plotCount: row.count,
    spike: false,
    spikeLabel: '',
  }));
  return [
    {
      lo: left - width * 1.25,
      hi: left - width * 0.25,
      count: spike.count,
      plotCount: remainingMax,
      spike: true,
      spikeLabel: `${Math.round(spike.share * 100)}% exactly ${Number(spike.value.toPrecision(3))}`,
    },
    ...normal,
  ];
}

function allGroups(result: GroupedSummaryResult): readonly GroupSummary[] {
  return result.other ? [...result.groups, result.other] : result.groups;
}

/**
 * What the folded tail of a categorical chart is called on the axis and in the
 * legend.
 *
 * Lower case, and exactly the string the server uses for its own tail bucket
 * (`groupedSummary` caps at 50 groups and folds the rest into `other`). Any
 * other spelling would draw two tails side by side -- "other" from the server
 * and "Other" from here -- naming the same idea twice. Sharing the name merges
 * them, which is also the arithmetic the reader expects.
 */
export const OTHER_GROUP = 'Other';

/**
 * Keep the `limit` biggest groups by record count and rename the rest to
 * "Other".
 *
 * Purely spec-side, over rows the panel already has: nothing is refetched and
 * no count is lost, the tail just stops asking for its own colour. The corpus
 * has 26 spellings of the manufacturer field, which drew a 24-entry legend
 * taller than the plot it explained and reused every hue three times over.
 *
 * Rank is by total `n` and ties break on the label, so the choice of which
 * groups survive is stable across refetches; the hue each survivor gets still
 * follows its position in the result, never its rank, so folding does not
 * repaint anything that was already on screen as a named group.
 */
export function foldOther<T extends { group: string; n: number }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.group !== OTHER_GROUP) totals.set(row.group, (totals.get(row.group) ?? 0) + row.n);
  }
  if (totals.size <= limit) return [...rows];
  const kept = new Set(
    [...totals]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([group]) => group),
  );
  return rows.map((row) => (kept.has(row.group) ? row : { ...row, group: OTHER_GROUP }));
}

/**
 * Box rows with the tail folded: one "Other" box per fold is not meaningful --
 * quantiles do not add up -- so the folded groups are summed into a single
 * record count and the widest span they cover.
 */
export function foldBoxRows(rows: readonly BoxRow[], limit: number): BoxRow[] {
  const folded = foldOther(rows, limit);
  const tail = folded.filter((row) => row.group === OTHER_GROUP);
  if (tail.length <= 1) return folded;
  const merged: BoxRow = {
    group: OTHER_GROUP,
    p05: Math.min(...tail.map((row) => row.p05)),
    p25: Math.min(...tail.map((row) => row.p25)),
    p50: tail.reduce((sum, row) => sum + row.p50 * row.n, 0) / tail.reduce((s, r) => s + r.n, 0),
    p75: Math.max(...tail.map((row) => row.p75)),
    p95: Math.max(...tail.map((row) => row.p95)),
    n: tail.reduce((sum, row) => sum + row.n, 0),
  };
  return [...folded.filter((row) => row.group !== OTHER_GROUP), merged];
}

/** Stable box ranking: median is the reading default; n answers a different question. */
export function sortBoxRows(rows: readonly BoxRow[], sort: 'median' | 'n' = 'median'): BoxRow[] {
  const field = sort === 'n' ? 'n' : 'p50';
  return [...rows].sort((a, b) => b[field] - a[field] || a.group.localeCompare(b.group));
}

/** Whether the p05..p95 span warrants a symlog box axis. */
export function boxNeedsSymlog(rows: readonly Pick<BoxRow, 'p05' | 'p95'>[]): boolean {
  return rows.some(
    (row) => row.p05 >= 0 && row.p95 > 0 && (row.p05 === 0 || row.p95 / row.p05 > 50),
  );
}

/** Grouped summaries to box rows, dropping groups the server found empty. */
export function boxRows(result: GroupedSummaryResult, field?: string | null): BoxRow[] {
  return allGroups(result)
    .filter((group) => group.quantiles !== null)
    .map((group) => {
      const q = group.quantiles as Quantiles;
      return {
        group: groupLabel(group.value, field),
        p05: q.p05,
        p25: q.p25,
        p50: q.p50,
        p75: q.p75,
        p95: q.p95,
        n: group.n,
      };
    });
}

/** Grouped summaries to faceted histogram rows, clipped per group. */
export function groupedBinRows(
  result: GroupedSummaryResult,
  clip: ClipMode = 'none',
  field?: string | null,
): GroupedBinRow[] {
  return allGroups(result).flatMap((group) => {
    const label = groupLabel(group.value, field);
    return clipBins(binRows(group.histogram), clipBounds(group, clip)).map((row) => ({
      ...row,
      group: label,
      facet: `${label} · n=${group.n.toLocaleString('en-US')}`,
    }));
  });
}

/** Grouped summaries to faceted ECDF rows, clipped per group. */
export function groupedEcdfRows(
  result: GroupedSummaryResult,
  clip: ClipMode = 'none',
  field?: string | null,
): GroupedEcdfRow[] {
  return allGroups(result).flatMap((group) => {
    const label = groupLabel(group.value, field);
    return clipSteps(ecdfRows(group), clipBounds(group, clip)).map((row) => ({
      ...row,
      group: label,
      facet: `${label} · n=${group.n.toLocaleString('en-US')}`,
    }));
  });
}

/* ----------------------------------------------------- comparison cohorts */

/**
 * One cohort's result, as the comparison row builders take it.
 *
 * `id` is what every row is keyed by and what the colour scale's domain holds;
 * `name` is only ever shown. Two cohorts can legitimately carry one name -- two
 * unnamed ones, two duplicates of a base, two equal time spans -- and keying the
 * rows on the name merged them into a single series: one ECDF line through both
 * curves, two boxes on one row, one legend entry.
 *
 * `base` is the cohort's own distribution (step one of the two-step fetch) and
 * `ranged` the one over the panel's shared range (step two). The ECDF and the
 * box only ever need `base`, which is what lets the panel draw them while the
 * shared-range histograms are still in flight.
 */
export interface CohortResult {
  id: string;
  name: string;
  base: DistributionResult | null;
  ranged: DistributionResult | null;
}

/** One point of a step histogram: the bin's lower edge and the share in it. */
export interface CohortBinRow {
  cohort: string;
  label: string;
  /** The bin's lower edge, which the step mark draws from. */
  lo: number;
  /** Its upper edge, for the tooltip's range. */
  hi: number;
  /** The bin's bounds written out, because a step's x is one edge and not a range. */
  range: string;
  share: number;
  count: number;
}

/** One point of a smoothed density curve. */
export interface CohortDensityRow {
  cohort: string;
  label: string;
  value: number;
  share: number;
  count: number;
}

/** One step of an overlaid ECDF. */
export type CohortEcdfRow = EcdfRow & { cohort: string; label: string };

/** One cohort's box. */
export type CohortBoxRow = Omit<BoxRow, 'group'> & { cohort: string; label: string; n: number };

/** How a bin's bounds are written in a tooltip: three significant digits, en dash. */
function binLabel(lo: number, hi: number): string {
  const digits = (value: number) => Number(value.toPrecision(3)).toString();
  return `${digits(lo)}\u2013${digits(hi)}`;
}

/**
 * How many finite values a histogram covers, which is what every share divides
 * by.
 *
 * The bins plus the two tails an explicit range pushed out, so the shares of one
 * cohort sum to 1 whether or not the shared range covered all of it -- and so a
 * cohort with a long tail outside the shared range is not drawn as though it
 * were concentrated inside it.
 */
function histogramTotal(result: DistributionResult): number {
  const inside = result.histogram.counts.reduce((sum, count) => sum + count, 0);
  return inside + (result.histogram.underflow ?? 0) + (result.histogram.overflow ?? 0);
}

/**
 * Share-normalized step-histogram points over shared bin edges, one series per
 * cohort.
 *
 * One point per bin at its **lower** edge, plus a closing point at the final
 * upper edge carrying the last bin's values. With `step-after` that is exactly
 * the histogram's outline: each value holds across its own bin, the last bin is
 * drawn full width, and the area mark shuts itself against the baseline at both
 * ends. The closing point repeats the last bin rather than dropping to zero, so
 * a tooltip on it states something true.
 *
 * A cohort with no ranged result yet contributes no points, and the others are
 * unaffected -- the silhouettes do not move as results land.
 */
export function cohortBinRows(cohorts: readonly CohortResult[]): CohortBinRow[] {
  const rows: CohortBinRow[] = [];
  for (const cohort of cohorts) {
    const result = cohort.ranged;
    if (!result) continue;
    const total = histogramTotal(result);
    if (total <= 0) continue;
    const bins = binRows(result.histogram);
    if (bins.length === 0) continue;
    for (const bin of bins) {
      rows.push({
        cohort: cohort.id,
        label: cohort.name,
        lo: bin.lo,
        hi: bin.hi,
        range: binLabel(bin.lo, bin.hi),
        share: bin.count / total,
        count: bin.count,
      });
    }
    const last = bins[bins.length - 1];
    rows.push({
      cohort: cohort.id,
      label: cohort.name,
      lo: last.hi,
      hi: last.hi,
      range: binLabel(last.lo, last.hi),
      share: last.count / total,
      count: last.count,
    });
  }
  return rows;
}

/**
 * One smoothed curve per cohort over the shared grid.
 *
 * From the **ranged** results, so every cohort's curve is smoothed over the same
 * bins and the shapes are comparable point for point. The bandwidth is each
 * cohort's own (Silverman off its own spread and size), because a bandwidth
 * borrowed from a 778,075-scan cohort would over-smooth a 400-scan one into a
 * straight line.
 */
export function cohortDensityRows(cohorts: readonly CohortResult[]): CohortDensityRow[] {
  return cohorts.flatMap((cohort) =>
    cohort.ranged === null
      ? []
      : densityPoints(cohort.ranged).map((point) => ({
          cohort: cohort.id,
          label: cohort.name,
          value: point.value,
          share: point.share,
          count: point.share * histogramTotal(cohort.ranged!),
        })),
  );
}

/** One cohort's smoothed curve, for a single-series distribution panel. */
export function densityRows(result: DistributionResult | null): readonly DensityPoint[] {
  return result === null ? [] : densityPoints(result).map(point => ({ ...point, count: point.share * histogramTotal(result) }));
}

/** One ECDF per cohort, from each cohort's own summary; see `ecdfRows`. */
export function cohortEcdfRows(
  cohorts: readonly CohortResult[],
  clip: ClipMode = 'none',
): CohortEcdfRow[] {
  return cohorts.flatMap((cohort) =>
    cohort.base === null
      ? []
      : ecdfRows(cohort.base, clip).map((row) => ({
          ...row,
          cohort: cohort.id,
          label: cohort.name,
        })),
  );
}

/** One box per cohort, from the quantiles each cohort's summary already carries. */
export function cohortBoxRows(cohorts: readonly CohortResult[]): CohortBoxRow[] {
  return cohorts.flatMap((cohort) => {
    const q = cohort.base?.quantiles;
    if (!cohort.base || !q) return [];
    return [
      {
        cohort: cohort.id,
        label: cohort.name,
        p05: q.p05,
        p25: q.p25,
        p50: q.p50,
        p75: q.p75,
        p95: q.p95,
        n: cohort.base.n,
      },
    ];
  });
}

/** Coverage buckets to rows, with group values stringified for the colour scale. */
export function coverageRows(result: CoverageResult, field?: string | null): CoverageRow[] {
  return result.buckets.map((bucket) => ({
    start: bucket.start,
    group: groupLabel(bucket.group, field),
    n: bucket.n,
  }));
}

/** Coverage values in the card's selected reading mode, after groups are folded. */
export function coverageModeRows(
  rows: readonly CoverageRow[],
  options: { cumulative: boolean; share: boolean },
): CoverageRow[] {
  let out = [...rows];
  if (options.cumulative) {
    const totals = new Map<string, number>();
    out = [...out]
      .sort((a, b) => a.group.localeCompare(b.group) || a.start.localeCompare(b.start))
      .map((row) => {
        const n = (totals.get(row.group) ?? 0) + row.n;
        totals.set(row.group, n);
        return { ...row, n };
      });
  }
  if (!options.share) return out;
  const totals = new Map<string, number>();
  for (const row of out) totals.set(row.start, (totals.get(row.start) ?? 0) + row.n);
  return out.map((row) => {
    const total = totals.get(row.start) ?? 0;
    return { ...row, n: total > 0 ? row.n / total : 0 };
  });
}
