import type { CoverageResult } from '@mriqc/shared';
import { comparisonChart, distributionChart, type ChartInput, type ChartOutput } from './select';
import { distributionBins } from './rows';
import { countsSpec } from './counts';
import { continuousAxisSpec } from './continuous-axis';
import { stackedHistogram } from './comparison';
import { coverageBins, coverageDistribution, timeBinValue } from './time-bins';
import { countBandChart, countBoxChart } from './grammar';
import { withValueAxes } from './value-axis';

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
  if (input.form === 'band' || input.form === 'box') {
    const sharedReady = resolved.cohortResults.length < 2 || resolved.cohortResults.every(cohort => cohort.ranged !== null);
    const series = resolved.cohortResults.map((cohort, index) => {
      const result = sharedReady ? cohort.ranged ?? cohort.base : null;
      return { id: cohort.id, name: cohort.name, color: input.cohorts[index]?.color ?? '#0072b2',
        bins: result ? distributionBins(result).map(bin => ({ ...bin,
          lo: time && bins ? timeBinValue(bins[index] ?? [], bin.lo) : bin.lo,
          hi: time && bins ? timeBinValue(bins[index] ?? [], bin.hi) : bin.hi })) : [] };
    });
    const result = input.form === 'band'
      ? countBandChart(series, input.axis.yMode === 'share' ? 'Share' : input.axis.countTitle, input.axis, input.options.fill, input.options.quantiles)
      : countBoxChart(input.axis.yMode === 'share' ? series.map(item => {
        const total = item.bins.reduce((sum, bin) => sum + bin.count, 0);
        return { ...item, bins: item.bins.map(bin => ({ ...bin, count: total ? bin.count / total : 0 })) };
      }) : series, input.axis.yMode === 'share' ? 'Share' : input.axis.countTitle);
    return { ...result, spec: withValueAxes(result.spec, input.axis, result.datasets), brushable: false,
      n: distributions?.[0]?.n ?? (input.result as { n?: number } | null)?.n ?? null };
  }
  let chart: ChartOutput;
  if (['line', 'area'].includes(input.form)) {
    const rows = resolved.cohortResults.flatMap(cohort => {
      const result = input.cohorts.length > 1 ? cohort.ranged : cohort.ranged ?? cohort.base;
      if (!result) return [];
      const total = result.histogram.counts.reduce((sum, n) => sum + n, 0);
      return distributionBins(result).map(bin => ({ ...bin, cohort: cohort.id, label: cohort.name,
        value: (bin.lo + bin.hi) / 2, share: total ? bin.count / total : 0 }));
    });
    chart = { spec: countsSpec(input.axis, input.form as 'line' | 'area', input.cohorts, input.options.layout),
      datasets: { counts: rows }, brushable: false, n: distributions?.[0]?.n ?? (input.result as { n?: number } | null)?.n ?? null };
  } else {
    chart = input.cohorts.length > 1 ? comparisonChart(resolved) : distributionChart(resolved);
    if (input.form === 'histogram' && input.cohorts.length > 1 && input.options.layout !== 'overlaid') {
      const stacked = stackedHistogram(resolved.axis, input.cohorts, resolved.cohortResults, input.options.layout === 'stacked100');
      chart = { ...chart, spec: stacked.spec, datasets: { cohorts: stacked.rows }, brushable: false };
    }
  }
  if (!time || !bins) return { ...chart, spec: chart.spec ? withValueAxes(chart.spec, input.axis, chart.datasets) : null };
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
    return row;
  })]));
  let spec = chart.spec ? continuousAxisSpec(chart.spec, input.axis, value => timeBinValue(bins[0] ?? [], value)) : null;
  if (spec && (input.form as string) === 'box') {
    spec = { ...spec, encoding: { ...('encoding' in spec ? spec.encoding : {}), tooltip: [
      { field: 'p50', type: 'temporal', title: 'Median upload date', format: '%d %b %Y' },
      { field: 'n', type: 'quantitative', title: input.axis.countTitle },
      { field: 'note', type: 'nominal', title: 'Approximation' },
    ] } } as typeof spec;
  }
  return { ...chart, spec: spec ? withValueAxes(spec, input.axis, datasets) : null, datasets, brushable: false, degenerateNote: undefined };
}
