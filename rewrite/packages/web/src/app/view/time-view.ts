import { timeGroups } from '../graph/time-groups';
import { withChipLegend } from '../panels/specs/chip-legend';
import { approximateTimeTail } from './time-tail';
import { fieldValueLabel, queryKey, type TimeSummaryResult } from '@mriqc/shared';
import { panelCohorts, panelQueries, resultOf } from '../graph/queries';
import { isDerivedCohort, type Panel, type State } from '../graph/state';
import { medianBandChart, type TimeSeries } from '../panels/specs/median-band';
import { OTHER_COLOR, type ChartTheme } from '../panels/specs/palette';
import type { PanelStatus, PanelView } from './panel-view';
import { activeView, fieldDef, metricDef, panelNotes, significant, unitNoun } from './text';

/** Bucket medians remain per series: medians cannot be pooled by averaging. */
export function timeSeriesStats(series: TimeSeries) {
  const buckets = [...series.result.buckets].sort((a, b) => a.start.localeCompare(b.start));
  const first = buckets[0], last = buckets.at(-1);
  return { n: buckets.reduce((sum, bucket) => sum + bucket.n, 0),
    first: first?.quantiles.p50 ?? null, last: last?.quantiles.p50 ?? null,
    change: first && last ? last.quantiles.p50 - first.quantiles.p50 : null,
    firstDate: first?.start, lastDate: last?.start };
}

export function timePanelView(state: State, panel: Panel, theme: ChartTheme): PanelView {
  const cohorts = panelCohorts(state, panel);
  const keys = panelQueries(state, panel).map(queryKey);
  const results = keys.slice(0, cohorts.length).map(key => resultOf<TimeSummaryResult>(state, key));
  const tail = keys.length > cohorts.length ? resultOf<TimeSummaryResult>(state, keys.at(-1)!) : null;
  const failures = keys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures }
    : keys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' }
    : { kind: 'ready', stale: keys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  const metric = metricDef(state, panel.y);
  const label = metric?.shortLabel ?? metric?.label ?? String(panel.y);
  const series: TimeSeries[] = [];
  results.forEach((result, i) => {
    if (!result) return;
    const cohort = cohorts[i];
    if (!panel.split) {
      series.push({ id: cohort.id, name: cohort.name, color: theme.categories[((cohort.color % 6) + 6) % 6], result });
      return;
    }
    const groups = timeGroups(result);
    const named = groups.filter(group => group.id !== 'other');
    const display = named.slice(0, 6);
    display.sort((a, b) => a.id.localeCompare(b.id)).forEach(({ id, buckets }, index) => {
      const other = buckets[0].isOther;
      series.push({ id, name: other ? 'Other' : fieldValueLabel(String(panel.split), buckets[0].group),
        color: other ? OTHER_COLOR : theme.categories[index % 6], result: { buckets } });
    });
    const remainder = [...named.slice(6), ...groups.filter(group => group.id === 'other')];
    if (remainder.length) series.push({ id: 'other', name: tail ? 'Other' : 'Other (approx.)', color: OTHER_COLOR,
      approximate: !tail, result: tail ?? approximateTimeTail(remainder.flatMap(group => group.buckets)) });
  });
  const chart = medianBandChart(series, label, theme);
  const n = results.every(Boolean) ? results.reduce((sum, result) => sum + result!.buckets.reduce((n, bucket) => n + bucket.n, 0), 0) : null;
  const rows = series.map(item => {
    const stats = timeSeriesStats(item);
    return { id: item.id, name: item.name, color: item.color,
      cells: [stats.n.toLocaleString('en-US'), ...[stats.first, stats.last, stats.change].map(value => `${item.approximate ? '≈ ' : ''}${significant(value)}`)] };
  });
  const by = panel.split ? fieldDef(state, panel.split)?.label ?? panel.split : 'cohorts';
  return {
    id: panel.id, panel, title: `${label} over time`, meaning: `${label} over upload time, median and middle half, by ${by}.`, subtitle: '',
    notes: panelNotes(state, panel), clipChip: null,
    metricHelp: metric ? { label: metric.label, taxonomy: metric.family, description: metric.description ?? null, unit: metric.unit ?? null } : null,
    specKey: JSON.stringify([theme.mode, panel.options.granularity, series.map(({ id, name, color }) => [id, name, color]), label]),
    spec: !panel.split && cohorts.length > 1 ? withChipLegend(chart.spec) : chart.spec, datasets: chart.datasets, table: null, status, brushable: false,
    hasRows: series.some(item => item.result.buckets.length), live: status.kind === 'ready', n,
    countLabel: `${unitNoun(activeView(state))} with dated finite values`,
    stats: [{ label: 'n', value: n?.toLocaleString('en-US') ?? '—', title: 'Total dated finite observations across the displayed series; overlapping cohorts contribute to each cohort.' }],
    cohorts: panel.split || cohorts.length < 2 ? null : cohorts.map((cohort, i) => ({ id: cohort.id, name: cohort.name,
      color: series[i]?.color ?? theme.categories[i % 6], n: results[i]?.buckets.reduce((sum, bucket) => sum + bucket.n, 0) ?? null, editable: !isDerivedCohort(cohort.id) })),
    comparison: null, splitCohorts: [], outsideNotes: [], partial: false,
    analysisHeaders: [panel.split ? String(by) : 'Cohort', 'n', 'First median', 'Last median', 'Change'], analysisRows: rows,
    analysisNote: 'Medians are shown for each series’ first and last occupied buckets. Faded buckets contain fewer than 20 observations.' +
      (series.some(item => item.approximate) ? ' Other quantiles are approximate, interpolated from count-weighted group quantiles; counts are exact.' : ''), correlationPairs: [],
  };
}
