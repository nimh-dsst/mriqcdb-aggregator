import type { CoverageResult } from '@mriqc/shared';
import { comparisonChart, distributionChart, type ChartInput, type ChartOutput } from './select';
import { distributionBins } from './rows';
import { lineSpec } from '../line/spec';
import { areaSpec } from '../area/spec';
import { continuousAxisSpec } from './continuous-axis';
import { stackedHistogram } from './comparison';
import { coverageBins, coverageDistribution, timeBinValue } from './time-bins';

/** One form dispatcher for metric and calendar distributions. */
export function continuousChart(input: ChartInput, coverage?: readonly (CoverageResult | null)[]): ChartOutput {
  const time = input.axis.xScale === 'time';
  // Calendar series share actual dates, not independent zero-based bucket grids.
  const starts = coverage?.flatMap(result => result?.buckets.map(bucket => Date.parse(bucket.start)).filter(Number.isFinite) ?? []) ?? [];
  if (starts.length && coverage) {
    const edges = [Math.min(...starts), Math.max(...starts)].map(start => ({ start: new Date(start).toISOString(), group: null, n: 0 }));
    coverage = coverage.map(result => result ? { ...result, buckets: [...result.buckets, ...edges] } : null);
  }
  const bins = coverage?.map(result => coverageBins(result, input.granularity));
  const distributions = coverage?.map(result => coverageDistribution(result, input.granularity));
  const resolved = distributions ? {
    ...input, clip: 'none' as const, result: distributions[0] ?? null,
    // Calendar coordinates are mapped after the common statistical transforms.
    axis: { ...input.axis, logScale: false, xRange: 'auto' as const },
    cohortResults: input.cohorts.map((cohort, i) => ({ id: cohort.id, name: cohort.label, base: distributions[i], ranged: distributions[i] })),
  } : input;
  let chart: ChartOutput;
  if (['line', 'area'].includes(input.form)) {
    // Share of the whole: every series divides by the total over all series.
    const totals = resolved.cohortResults.map(cohort => {
      const result = input.cohorts.length > 1 ? cohort.ranged : cohort.ranged ?? cohort.base;
      return result ? result.histogram.counts.reduce((sum, n) => sum + n, 0) : 0;
    });
    const grand = totals.reduce((sum, n) => sum + n, 0);
    const rows = resolved.cohortResults.flatMap(cohort => {
      const result = input.cohorts.length > 1 ? cohort.ranged : cohort.ranged ?? cohort.base;
      if (!result) return [];
      return distributionBins(result).map(bin => ({ ...bin, cohort: cohort.id, label: cohort.name,
        value: (bin.lo + bin.hi) / 2, share: grand ? bin.count / grand : 0 }));
    });
    chart = { spec: (input.form === 'area' ? areaSpec : lineSpec)(input.axis, input.cohorts, input.options.layout),
      datasets: { counts: rows }, brushable: false, n: distributions?.[0]?.n ?? (input.result as { n?: number } | null)?.n ?? null };
  } else {
    chart = input.cohorts.length > 1 ? comparisonChart(resolved) : distributionChart(resolved);
    if (input.form === 'histogram' && input.cohorts.length > 1 && input.options.layout !== 'overlaid') {
      const stacked = stackedHistogram(resolved.axis, input.cohorts, resolved.cohortResults, input.options.layout === 'stacked100');
      chart = { ...chart, spec: stacked.spec, datasets: { cohorts: stacked.rows }, brushable: false };
    }
  }
  if (!time || !bins) return chart;
  if (input.form === 'ecdf') {
    const rows = resolved.cohortResults.flatMap(cohort => {
      const result = cohort.base;
      if (!result || result.n <= 0) return [];
      let cumulative = 0;
      return [{ value: 0, p: 0, cohort: cohort.id, label: cohort.name }, ...result.histogram.counts.map((count, index) => {
        cumulative += count;
        return { value: index + 1, p: cumulative / result.n, cohort: cohort.id, label: cohort.name };
      })];
    });
    chart = { ...chart, datasets: { [input.cohorts.length > 1 ? 'cohorts' : 'population']: rows } };
  }
  const note = `from ${{ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[input.granularity]} counts`;
  const datasets = Object.fromEntries(Object.entries(chart.datasets).map(([name, rows]) => [name, rows.map(raw => {
    const row = { ...(raw as Record<string, unknown>) };
    const index = typeof row['cohort'] === 'string' ? input.cohorts.findIndex(cohort => cohort.id === row['cohort']) : 0;
    const own = bins[Math.max(0, index)] ?? [];
    for (const key of ['lo', 'hi', 'value', 'p01', 'p05', 'p25', 'p50', 'p75', 'p95', 'p99']) {
      if (typeof row[key] === 'number') row[key] = timeBinValue(own, row[key] as number);
    }
    if (input.form === 'box') row['note'] = note;
    return row;
  })]));
  // The axis spans the first bucket's start to the last bucket's END across
  // every series; a domain inferred from bucket starts stopped one bucket
  // short and let the last bar run off the plot.
  const edges = bins.flatMap(own => own.length ? [own[0].lo, own[own.length - 1].hi] : []);
  const timeDomain = edges.length ? ([Math.min(...edges), Math.max(...edges)] as const) : undefined;
  let spec = chart.spec ? continuousAxisSpec(chart.spec, { ...input.axis, timeDomain }, value => timeBinValue(bins[0] ?? [], value)) : null;
  if (spec && input.form === 'box') {
    spec = { ...spec, encoding: { ...('encoding' in spec ? spec.encoding : {}), tooltip: [
      { field: 'p50', type: 'temporal', title: 'Median upload date', format: '%d %b %Y' },
      { field: 'n', type: 'quantitative', title: input.axis.countTitle },
      { field: 'note', type: 'nominal', title: 'Approximation' },
    ] } } as typeof spec;
  }
  return { ...chart, spec, datasets, brushable: false, degenerateNote: undefined };
}
