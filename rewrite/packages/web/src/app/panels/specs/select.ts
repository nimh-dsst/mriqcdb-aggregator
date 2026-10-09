/**
 * Spec selection: which chart a panel draws, and the rows that chart names.
 *
 * One function per panel kind, each a pure function of an already-resolved
 * {@link ChartInput} -- no `State`, no query keys, no catalog. The panel view
 * gathers the results and hands them over; this file decides which builder and
 * which row transform go together, which is the last place in the dashboard
 * that knows both a spec and its data.
 *
 * `PANEL_KINDS` (`graph/panel-shapes.ts`) holds the reference to the builder for
 * each kind, so nothing outside this file switches on a chart name.
 */

import type { TopLevelSpec } from 'vega-lite';
import type {
  ClipMode,
  CoverageResult,
  DistributionResult,
  Granularity,
  GroupSummary,
  GroupedSummaryResult,
  MetricSummary,
} from '@mriqc/shared';
import type { PanelChart, PanelOptions } from '../../graph/state';
import { boxSpec } from './box';
import {
  cohortBoxSpec,
  stackedHistogram,
  overlaidDensitySpec,
  overlaidEcdfSpec,
  overlaidHistogramSpec,
  COHORTS_DATA,
  type CohortSeries,
} from './comparison';
import { COVERAGE_DATA, coverageSpec } from './coverage';
import { ecdfSpec, facetedEcdfSpec } from './ecdf';
import {
  GROUPS_DATA,
  POPULATION_DATA,
  densitySpec,
  facetedHistogramSpec,
  histogramSpec,
  type MetricAxis,
} from './histogram';
import {
  MAX_CATEGORIES,
  MAX_FACET_GROUPS,
  MAX_OVERLAY_GROUPS,
  batlowRange,
  groupColor,
  groupRange,
} from './palette';
import {
  boxRows,
  boxNeedsSymlog,
  cohortBinRows,
  cohortBoxRows,
  cohortDensityRows,
  cohortEcdfRows,
  clipBounds,
  coverageRows,
  coverageModeRows,
  densityRows,
  degenerateHistogramRows,
  degenerateSpike,
  distributionBins,
  ecdfRows,
  foldBoxRows,
  foldOther,
  groupLabel,
  groupedBinRows,
  groupedEcdfRows,
  sortBoxRows,
  type CohortResult,
} from './rows';

/** Everything a chart builder reads, resolved from state by the panel view. */
export interface ChartInput {
  /** The chart the panel is set to, already constrained to its kind's list. */
  form: PanelChart;
  axis: MetricAxis;
  clip: ClipMode;
  /** The interval this panel drew, which seeds the spec's brush parameter. */
  brush: readonly [number, number] | null;
  /** The split field's label, for facet headers and legends. */
  groupLabel: string;
  /** The split field's id, which is how a stored value becomes a display string. */
  groupField: string | null;
  /** True for numeric bins and intrinsically ordered categorical fields. */
  groupOrdered: boolean;
  /** The displayed scope of a one-cohort card, used by its one-row box. */
  cohortLabel: string;
  granularity: Granularity;
  options: PanelOptions;
  /** The result of the panel's first key, whatever procedure answered it. */
  result: unknown;
  /** A comparison panel's cohorts, as the colour scale declares them. */
  cohorts: readonly CohortSeries[];
  /** The same cohorts' two-step results, in the same order. */
  cohortResults: readonly CohortResult[];
}

/** Spec and rows from one state, which is the pair the Vega directive diffs. */
export interface ChartOutput {
  spec: TopLevelSpec | null;
  datasets: Readonly<Record<string, readonly unknown[]>>;
  /** True when this chart carries the interval brush. */
  brushable: boolean;
  /** The row count behind the chart, for the card's caption. */
  n: number | null;
  /** A visible explanation for a collapsed or overwhelmingly dominant bin. */
  degenerateNote?: string;
}

const EMPTY_DATASETS: Readonly<Record<string, readonly unknown[]>> = {};

/**
 * A ready result, only if it actually looks like a `DistributionResult`.
 *
 * A dataset entry's result is `unknown`: the runner writes whatever the `Api`
 * handed back, and nothing between there and here narrows it. Most readers are
 * row builders, where a malformed result draws an empty chart -- but the shared
 * range is read *inside query-key construction*, which the reducer's `evict`
 * calls, so a bad shape there would throw out of the fold and freeze the
 * dashboard rather than blank one card.
 */
export function asDistributionResult(result: unknown): DistributionResult | null {
  if (result === null || result === undefined || typeof result !== 'object') return null;
  const histogram = (result as Partial<DistributionResult>).histogram;
  if (!histogram || !Array.isArray(histogram.counts)) return null;
  if (typeof (result as Partial<DistributionResult>).n !== 'number') return null;
  return result as DistributionResult;
}

function sumGroups(result: GroupedSummaryResult | null): number | null {
  if (!result) return null;
  return result.groups.reduce((sum, g) => sum + g.n, 0) + (result.other?.n ?? 0);
}

/** The faceted small multiples a legacy grouped panel produces. */
function facets(input: ChartInput, ecdf: boolean): ChartOutput {
  const raw = (input.result ?? null) as GroupedSummaryResult | null;
  const result = raw ? foldedGroups(raw, MAX_FACET_GROUPS, input.groupField) : null;
  const rows = result
    ? ecdf
      ? groupedEcdfRows(result, input.clip, input.groupField)
      : groupedBinRows(result, input.clip, input.groupField)
    : [];
  const groups = [...new Set(rows.map((row) => row.group))];
  if (!input.groupOrdered) groups.sort();
  return {
    spec: ecdf
      ? facetedEcdfSpec(input.axis, input.groupLabel, groups, input.groupOrdered)
      : facetedHistogramSpec(input.axis, input.groupLabel, groups, input.groupOrdered),
    datasets: { [GROUPS_DATA]: rows },
    brushable: false,
    n: sumGroups(result),
  };
}

/** Facets from the same cohort distributions used by split overlays. */
function cohortFacets(input: ChartInput, ecdf: boolean): ChartOutput {
  const rows = input.cohortResults.flatMap((cohort) => {
    const result = ecdf ? cohort.base : cohort.ranged;
    if (result === null) return [];
    const facet = `${cohort.name} · n=${result.n.toLocaleString('en-US')}`;
    return (ecdf ? ecdfRows(result, input.clip) : distributionBins(result)).map((row) => ({
      ...row,
      group: cohort.name,
      facet,
    }));
  });
  const groups = input.cohorts.map((cohort) => cohort.label);
  return {
    spec: ecdf
      ? facetedEcdfSpec(input.axis, input.groupLabel, groups, input.groupOrdered)
      : facetedHistogramSpec(input.axis, input.groupLabel, groups, input.groupOrdered),
    datasets: { [GROUPS_DATA]: rows },
    brushable: false,
    n: input.cohortResults.reduce((sum, cohort) => sum + (cohort.base?.n ?? 0), 0),
  };
}

/** Group rows ranked by their own n, with one arithmetic tail rather than many overplotted "Other" marks. */
function foldedGroups(
  result: GroupedSummaryResult,
  limit: number,
  field: string | null,
): GroupedSummaryResult {
  const all = result.groups.filter((group) => groupLabel(group.value, field) !== 'Other');
  const existingOther = [...result.groups.filter((group) => groupLabel(group.value, field) === 'Other'), ...(result.other ? [result.other] : [])];
  const ranked = [...all].sort(
    (a, b) => b.n - a.n || groupLabel(a.value, field).localeCompare(groupLabel(b.value, field)),
  );
  if (ranked.length <= limit) return { groups: ranked, ...(existingOther.length ? { other: mergeGroups(existingOther) } : {}) };
  const kept = ranked.slice(0, limit);
  const tail = [...ranked.slice(limit), ...existingOther];
  return { groups: kept, other: mergeGroups(tail) };
}

/** Legacy fallback for numeric/date splits, which cannot be expressed as exact filter cohorts. */
function splitOverlay(input: ChartInput, result: GroupedSummaryResult) {
  const folded = foldedGroups(result, MAX_OVERLAY_GROUPS, input.groupField);
  const groups = [...folded.groups, ...(folded.other ? [folded.other] : [])];
  const orderedColors = input.groupOrdered
    ? batlowRange(
        groups.filter((group) => groupLabel(group.value, input.groupField) !== 'Other').length,
      )
    : [];
  const categoricalColors = groupRange(groups.map((group) => groupLabel(group.value, input.groupField)));
  let orderedIndex = 0;
  const cohorts = groups.map((group, index) => {
    const label = groupLabel(group.value, input.groupField);
    const color =
      label === 'Other'
        ? groupColor(label)
        : input.groupOrdered
          ? orderedColors[orderedIndex++]
          : categoricalColors[index];
    return { id: label, label, color };
  });
  const results = groups.map((group) => {
    const label = groupLabel(group.value, input.groupField);
    const summary = { ...group, histogram: group.histogram } as DistributionResult;
    return { id: label, name: label, base: summary, ranged: summary };
  });
  return { cohorts, results };
}

/** Merge a folded tail onto the shared grouped-summary grid. */
function mergeGroups(groups: readonly GroupSummary[]): GroupSummary {
  if (groups.length === 1) return { ...groups[0], value: 'Other' };
  const first = groups[0];
  const counts = first.histogram.counts.map((_, index) =>
    groups.reduce((sum, group) => sum + (group.histogram.counts[index] ?? 0), 0),
  );
  const n = groups.reduce((sum, group) => sum + group.n, 0);
  return {
    value: 'Other',
    n,
    min: Math.min(...groups.map((group) => group.min ?? Number.POSITIVE_INFINITY)),
    max: Math.max(...groups.map((group) => group.max ?? Number.NEGATIVE_INFINITY)),
    mean: null,
    stddev: null,
    quantiles: null,
    histogram: { ...first.histogram, counts },
  };
}

/** The box domain includes its whiskers and any wider selected clip range. */
function boxDomain(
  rows: readonly { p05: number; p95: number }[],
  summaries: readonly MetricSummary[],
  clip: ClipMode,
): readonly [number, number] | null {
  const values = rows.flatMap((row) => [row.p05, row.p95]).filter(Number.isFinite);
  for (const summary of summaries) {
    const selected = clipBounds(summary, clip);
    if (selected) values.push(selected[0], selected[1]);
    else if (clip === 'none' && summary.min !== null && summary.max !== null)
      values.push(summary.min, summary.max);
  }
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? [lo, hi] : null;
}

/**
 * One metric over this dashboard: bars, a smoothed share, or an ECDF -- and the
 * same metric faceted by a split field, which is the one case a distribution
 * panel draws a grouped result.
 */
export function distributionChart(input: ChartInput): ChartOutput {
  if (input.groupField !== null) {
    const result = (input.result ?? null) as GroupedSummaryResult | null;
    if (input.form === 'box') {
      const rows = result
        ? sortBoxRows(
            foldBoxRows(boxRows(result, input.groupField), MAX_CATEGORIES),
            input.options.boxSort,
          )
        : [];
      return {
        spec: boxSpec(
          input.axis,
          input.groupLabel,
          input.options.boxSort,
          boxNeedsSymlog(rows),
          result
            ? boxDomain(
                rows,
                [...result.groups, ...(result.other ? [result.other] : [])],
                input.clip,
              )
            : null,
          rows.map((row) => row.group),
          input.groupOrdered,
        ),
        datasets: { [GROUPS_DATA]: rows },
        brushable: false,
        n: sumGroups(result),
      };
    }
    const cohortBacked = input.cohorts.length > 0;
    if (input.options.splitPresentation === 'facets') {
      return cohortBacked
        ? cohortFacets(input, input.form === 'ecdf')
        : facets(input, input.form === 'ecdf');
    }
    const overlay = cohortBacked
      ? { cohorts: input.cohorts, results: input.cohortResults }
      : result
        ? splitOverlay(input, result)
        : { cohorts: [], results: [] };
    const n = cohortBacked
      ? input.cohortResults.reduce((sum, cohort) => sum + (cohort.base?.n ?? 0), 0)
      : sumGroups(result);
    if (input.options.layout !== 'overlaid') {
      const stacked = stackedHistogram(input.axis, overlay.cohorts, overlay.results, input.options.layout === 'stacked100');
      return { spec: stacked.spec, datasets: { [COHORTS_DATA]: stacked.rows }, brushable: false, n };
    }
    if (input.form === 'ecdf') {
      return {
        spec: overlaidEcdfSpec(input.axis, overlay.cohorts, input.brush),
        datasets: { [COHORTS_DATA]: cohortEcdfRows(overlay.results, input.clip) },
        brushable: true,
        n,
      };
    }
    if (input.form === 'histogram') {
      return {
        spec: overlaidHistogramSpec(input.axis, overlay.cohorts, input.brush),
        datasets: { [COHORTS_DATA]: cohortBinRows(overlay.results) },
        brushable: true,
        n,
      };
    }
    return {
      spec: overlaidDensitySpec(input.axis, overlay.cohorts, input.brush),
      datasets: { [COHORTS_DATA]: cohortDensityRows(overlay.results) },
      brushable: true,
      n,
    };
  }
  const result = asDistributionResult(input.result);
  const spike = result === null ? null : degenerateSpike(result);
  // The server already binned over the clipped range, so the bars need no
  // second pass. The ECDF still does: its quantile points come from the
  // unclipped summary, so p01/p99 can sit outside the histogram's range. The
  // density is a pure function of the fine histogram the panel asked for, so it
  // needs no request of its own either.
  const boxRowsForPopulation = result?.quantiles
    ? [
        {
          group: input.cohortLabel,
          p05: result.quantiles.p05,
          p25: result.quantiles.p25,
          p50: result.quantiles.p50,
          p75: result.quantiles.p75,
          p95: result.quantiles.p95,
          n: result.n,
        },
      ]
    : [];
  const spec =
    input.form === 'box'
      ? boxSpec(
          input.axis,
          'Distribution',
          input.options.boxSort,
          boxNeedsSymlog(boxRowsForPopulation),
          result ? boxDomain(boxRowsForPopulation, [result], input.clip) : null,
          boxRowsForPopulation.map((row) => row.group),
          false,
        )
      : input.form === 'ecdf'
        ? ecdfSpec(input.axis, input.brush)
        : input.form === 'density'
          ? densitySpec(input.axis, input.brush)
          : histogramSpec(input.axis, input.brush, input.options.bins, spike !== null);
  const rows = !result
    ? []
    : input.form === 'box'
      ? boxRowsForPopulation
      : input.form === 'ecdf'
        ? ecdfRows(result, input.clip)
        : input.form === 'density'
          ? densityRows(result)
          : spike === null
            ? distributionBins(result)
            : degenerateHistogramRows(result, spike);
  return {
    spec,
    datasets: { [input.form === 'box' ? GROUPS_DATA : POPULATION_DATA]:
      input.form === 'histogram' && input.options.yMode === 'share' && result ? rows.map(row => {
        const bin = row as { count: number };
        const total = result.histogram.counts.reduce((sum, count) => sum + count, 0);
        return { ...row, share: total ? bin.count / total : 0 };
      }) : rows },
    brushable: input.form !== 'box',
    n: result?.n ?? null,
    degenerateNote:
      spike === null
        ? undefined
        : `${Math.round(spike.share * 100)}% of ${input.axis.countTitle.toLowerCase()} are exactly ${Number(spike.value.toPrecision(3))}.`,
  };
}

/** One metric per group: a box row each, or the faceted small multiples. */
export function groupedChart(input: ChartInput): ChartOutput {
  const result = (input.result ?? null) as GroupedSummaryResult | null;
  const rows = result
    ? sortBoxRows(
        foldBoxRows(boxRows(result, input.groupField), MAX_CATEGORIES),
        input.options.boxSort,
      )
    : [];
  return {
    spec: boxSpec(
      input.axis,
      input.groupLabel,
      input.options.boxSort,
      boxNeedsSymlog(rows),
      result
        ? boxDomain(rows, [...result.groups, ...(result.other ? [result.other] : [])], input.clip)
        : null,
      rows.map((row) => row.group),
      input.groupOrdered,
    ),
    // The tail folds here rather than in the spec: the spec sees rows, and this
    // is the last place that has them as data.
    datasets: {
      [GROUPS_DATA]: rows,
    },
    brushable: false,
    n: sumGroups(result),
  };
}

/** Uploads per time bucket, stacked or as an area. */
export function coverageChart(input: ChartInput): ChartOutput {
  const result = (input.result ?? null) as CoverageResult | null;
  const chart = input.form === 'area' ? 'area' : input.form === 'line' ? 'line' : 'bars';
  const rows = result
    ? coverageModeRows(
        foldOther(coverageRows(result, input.groupField), MAX_CATEGORIES),
        input.options,
      )
    : [];
  const groups = [...new Set(rows.map((row) => row.group))].sort((a, b) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b, 'en', { numeric: true }));
  return {
    spec: coverageSpec(
      chart,
      input.groupLabel,
      input.granularity,
      input.axis.countTitle,
      input.options,
      groups,
      input.groupOrdered,
      input.axis.theme,
    ),
    datasets: { [COVERAGE_DATA]: rows },
    brushable: false,
    n: result ? result.buckets.reduce((sum, b) => sum + b.n, 0) : null,
  };
}

/** The raw drill-down draws no Vega chart at all; the CDK table has the rows. */
export function sampleChart(): ChartOutput {
  return { spec: null, datasets: EMPTY_DATASETS, brushable: false, n: null };
}

/**
 * One metric across cohorts: overlaid silhouettes, one ECDF line each, or a box
 * row per cohort.
 *
 * `n` is null throughout: a single total would be the sum of cohorts that
 * overlap, which counts nothing. The card's count line is a chip per cohort.
 */
export function comparisonChart(input: ChartInput): ChartOutput {
  const { axis, cohorts, cohortResults: results, brush } = input;
  if (input.form === 'box') {
    const rows = cohortBoxRows(results).sort(
      (a, b) =>
        (input.options.boxSort === 'n' ? b.n - a.n : b.p50 - a.p50) ||
        a.label.localeCompare(b.label),
    );
    const summaries = results.flatMap((result) => (result.base ? [result.base] : []));
    return {
      spec: cohortBoxSpec(
        axis,
        cohorts,
        input.options.boxSort,
        boxNeedsSymlog(rows),
        boxDomain(rows, summaries, input.clip),
      ),
      datasets: { [COHORTS_DATA]: rows },
      // A box has no x interval to drag: the mark is a summary, not a
      // distribution over the axis.
      brushable: false,
      n: null,
    };
  }
  if (input.form === 'ecdf') {
    return {
      spec: overlaidEcdfSpec(axis, cohorts, brush),
      datasets: { [COHORTS_DATA]: cohortEcdfRows(results, input.clip) },
      brushable: true,
      n: null,
    };
  }
  if (input.form === 'histogram') {
    return {
      spec: overlaidHistogramSpec(axis, cohorts, brush),
      datasets: { [COHORTS_DATA]: cohortBinRows(results) },
      brushable: true,
      n: null,
    };
  }
  return {
    spec: overlaidDensitySpec(axis, cohorts, brush),
    datasets: { [COHORTS_DATA]: cohortDensityRows(results) },
    brushable: true,
    n: null,
  };
}
