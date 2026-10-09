import type { CoverageResult, DistributionResult } from '@mriqc/shared';
import { queryKey } from '../api/api';
import { coverageBins, coverageDistribution, timeBinValue } from '../panels/specs/time-bins';
import { cohortQuery, distributionResult, resultOf, scopedQuery } from './queries';
import type { Cohort, ColumnRef, Panel, State } from './state';

export function mapQuantiles(q: NonNullable<DistributionResult['quantiles']>, map: (value: number) => number) {
  return { p01: map(q.p01), p05: map(q.p05), p25: map(q.p25), p50: map(q.p50), p75: map(q.p75), p95: map(q.p95), p99: map(q.p99) };
}

/** Upload time is a coverage field, not a metric accepted by distribution. */
export function ySummaryQuery(state: State, panel: Panel, cohort: Cohort) {
  const quantity = { ...panel, x: panel.y as ColumnRef, options: { ...panel.options, xRange: 'auto' as const, granularity: 'day' as const } };
  return panel.y === 'created_at' ? scopedQuery(state, quantity, cohort, 'coverage')! : cohortQuery(state, quantity, cohort);
}

/** Date quantiles have daily resolution; never present them as exact timestamps. */
export function dateSummary(result: CoverageResult | null): DistributionResult | null {
  if (!result) return null;
  const bins = coverageBins(result, 'day');
  const summary = coverageDistribution(result, 'day');
  const date = (value: number | null) => value === null ? null : timeBinValue(bins, value);
  return { ...summary, min: date(summary.min), max: date(summary.max), mean: date(summary.mean),
    stddev: summary.stddev === null ? null : summary.stddev * 86400000,
    quantiles: summary.quantiles ? mapQuantiles(summary.quantiles, value => timeBinValue(bins, value)) : null,
    histogram: { lo: bins[0]?.lo ?? 0, hi: bins.at(-1)?.hi ?? 0, width: 86400000, counts: summary.histogram.counts } };
}

export function ySummaryResult(state: State, panel: Panel, cohort: Cohort): DistributionResult | null {
  const key = queryKey(ySummaryQuery(state, panel, cohort));
  return panel.y === 'created_at' ? dateSummary(resultOf<CoverageResult>(state, key)) : distributionResult(state, key);
}
