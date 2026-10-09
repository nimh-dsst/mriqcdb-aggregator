import { queryKey } from '../api/api';
import { type BinnedSummaryResult, type GroupedSummaryResult, type CoverageResult, fieldValueLabel } from '@mriqc/shared';
import { dateSummary, mapQuantiles } from '../graph/y-summary';
import { axisType } from '../graph/panel-shapes';
import { withChipLegend } from '../panels/specs/chip-legend';
import { binnedQueries, panelCohort, panelCohorts, panelQueries, resultOf, scopedQuery } from '../graph/queries';
import type { Panel, State } from '../graph/state';
import { bandChart, type BinnedSeries } from '../panels/specs/band';
import { columnYChart, type SummaryForm } from '../panels/specs/grammar';
import { baseConfig, FILLS_CONTAINER } from '../panels/specs/palette';
import type { TopLevelSpec } from 'vega-lite';
import { axisEvidence } from '../graph/axis-options';
import { OTHER_COLOR, valueScale, type ChartTheme } from '../panels/specs/palette';
import type { PanelStatus, PanelView } from './panel-view';
import { activeView, metricDef, panelNotes, significant, unitNoun } from './text';

export function timeSeriesStats(series: BinnedSeries) {
  const buckets = [...series.result.buckets].sort((a, b) => a.lo - b.lo);
  const first = buckets[0], last = buckets.at(-1);
  return { n: buckets.reduce((sum, bucket) => sum + bucket.n, 0),
    first: first?.quantiles.p50 ?? null, last: last?.quantiles.p50 ?? null,
    change: first && last ? last.quantiles.p50 - first.quantiles.p50 : null,
    firstDate: first?.start, lastDate: last?.start };
}


export function timePanelView(state: State, panel: Panel, theme: ChartTheme): PanelView {
  const cohorts = panelCohorts(state, panel);
  const keys = panelQueries(state, panel).map(queryKey);
  const resultFor = (cohort: typeof cohorts[number]) => {
    if (axisType(panel.x) === 'categorical') {
      const query = scopedQuery(state, panel, cohort, 'groupedSummary');
      if (query?.proc === 'coverage') {
        const result = resultOf<CoverageResult>(state, queryKey(query));
        if (!result) return null;
        const groups = [...new Set(result.buckets.map(bucket => bucket.group))];
        return { xKind: 'metric', yKind: 'time', range: [0, groups.length], buckets: groups.flatMap((group, index) => {
          const summary = dateSummary({ buckets: result.buckets.filter(bucket => bucket.group === group) });
          return summary?.quantiles ? [{ lo: index, hi: index + 1, group: fieldValueLabel(String(panel.x), group), n: summary.n, isOther: false, thin: summary.n < 20, mean: summary.mean! / 86400000 - 10957,
            quantiles: mapQuantiles(summary.quantiles, value => value / 86400000 - 10957) }] : [];
        }) } as BinnedSummaryResult;
      }
      const result = query ? resultOf<GroupedSummaryResult>(state, queryKey(query)) : null;
      const groups = result ? [...result.groups, ...(result.other ? [result.other] : [])] : [];
      return result ? { xKind: 'metric', yKind: 'metric', range: [0, groups.length], buckets: groups.flatMap((group, index) =>
        group.quantiles ? [{ lo: index, hi: index + 1, group: fieldValueLabel(String(panel.x), group.value), n: group.n, isOther: group === result.other, quantiles: group.quantiles, mean: group.mean, min: group.min, max: group.max, thin: group.n < 20 }] : []) } as BinnedSummaryResult : null;
    }
    const base = scopedQuery(state, panel, cohort, 'binnedSummary');
    const query = base && binnedQueries(state, panel).filter(query => queryKey({ ...query, range: undefined }) === queryKey({ ...base, range: undefined } as typeof query)).at(-1);
    return query ? resultOf<BinnedSummaryResult>(state, queryKey(query)) : null;
  };
  const results = cohorts.map(resultFor);
  const failures = keys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures }
    : keys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' }
    : { kind: 'ready', stale: keys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  const metric = metricDef(state, panel.y), label = panel.y === 'created_at' ? 'Upload time' : metric?.shortLabel ?? metric?.label ?? String(panel.y);
  const color = (index: number) => cohorts[index]?.name === 'Other' ? OTHER_COLOR : theme.categories[index % 6];
  const series: BinnedSeries[] = cohorts.flatMap((cohort,index) => results[index] ? [{
    id: cohort.id, name: cohort.name, color: color(index), result: results[index]!,
  }] : []);
  const time = panel.x === 'created_at';
  const xLabel = time ? 'Upload time' : metricDef(state, panel.x)?.shortLabel ?? metricDef(state, panel.x)?.label ?? String(panel.x);
  const tails = panel.options.quantiles === 'tails';
  const lower = tails ? 'p05' : 'p25', upper = tails ? 'p95' : 'p75';
  const lowerLabel = tails ? 'p05' : 'Q1', upperLabel = tails ? 'p95' : 'Q3';
  const evidence = axisEvidence(state, panel);
  const axis = { label: xLabel, theme, logScale: false,
    xScale: time ? 'time' : panel.options.xScale === 'log' && !evidence.positive ? 'symlog' : panel.options.xScale,
    xRange: panel.options.xRange, constant: evidence.constant, granularity: panel.options.granularity, countTitle: label,
    yScale: panel.options.yScale, yRange: panel.options.yRange } as const;
  let chart = bandChart(series, label, axis, panel.options.fill, panel.options.quantiles,
    valueScale(panel.options.yScale, panel.options.yRange));
  if (panel.form !== 'band') {
    const datasets: Record<string, readonly unknown[]> = {};
    let combined: TopLevelSpec | null = null;
    for (const item of series) {
      const rendered = columnYChart(item.result, `${panel.aggregate} ${label}`, axis, (panel.form === 'bars' || panel.form === 'share' ? 'histogram' : panel.form) as SummaryForm, panel.aggregate);
      const spec = structuredClone(rendered.spec) as unknown as Record<string, unknown>;
      const rename = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(rename); return; }
        if (!node || typeof node !== 'object') return;
        const record = node as Record<string, any>;
        if (axisType(panel.x) === 'categorical' && record['encoding']?.x) {
          record['encoding'].x = { field: 'group', type: 'nominal', title: xLabel };
          delete record['encoding'].x2;
        }
        if (record['encoding']?.y) {
          record['encoding'].color = { field: 'seriesId', type: 'nominal', scale: { domain: series.map(s => s.id), range: series.map(s => s.color) }, legend: null };
          record['encoding'].y.stack = panel.form === 'area' && series.length > 1 ? 'zero' : null;
          record['encoding'].tooltip = [{ field: 'seriesName', title: 'Series' }, { field: 'value', type: 'quantitative', title: label }];
        }
        Object.values(record).forEach(rename);
      };
      rename(spec);
      for (const [name, rows] of Object.entries(rendered.datasets)) datasets[name] = [...datasets[name] ?? [], ...rows.map(row => ({ ...(row as object), seriesId: item.id, seriesName: item.name }))];
      combined ??= spec as unknown as TopLevelSpec;
    }
    chart = { spec: combined ?? { ...baseConfig(theme), ...FILLS_CONTAINER, data: { values: [] }, mark: 'point' } as TopLevelSpec, datasets };
  }
  const aggregate = resultFor(panelCohort(state,panel));
  const n = aggregate?.buckets.reduce((sum,bucket) => sum + bucket.n,0) ?? null;
  const rows = series.map(item => {
    const stats = timeSeriesStats(item);
    const buckets = [...item.result.buckets].sort((a, b) => a.lo - b.lo);
    const first = buckets[0]?.quantiles, last = buckets.at(-1)?.quantiles;
    return { id:item.id, name:item.name,color:item.color,cells:[stats.n.toLocaleString('en-US'),
      ...[first?.[lower], stats.first, first?.[upper], last?.[lower], stats.last, last?.[upper], stats.change].map(value => significant(value ?? null))] };
  });
  return {
    id:panel.id,panel,title:time ? `${label} over time` : `${label} vs ${xLabel}`,meaning:label+' per '+xLabel+' bin: '+(panel.form === 'band' ? (panel.options.fill === 'lines' ? `${lowerLabel}, median and ${upperLabel} lines.` : `median and ${lowerLabel}–${upperLabel} band.`) : `${panel.aggregate}.`),subtitle:'',
    notes:panelNotes(state,panel),clipChip:null,
    metricHelp:metric ? {label:metric.label,taxonomy:metric.family,description:metric.description??null,unit:metric.unit??null}:null,
    specKey:JSON.stringify([theme.mode,panel.form,panel.x,panel.y,panel.aggregate,panel.options,series.map(item=>[item.id,item.name,item.color])]),
    spec:withChipLegend(chart.spec),datasets:chart.datasets,table:null,status,brushable:false,
    hasRows:series.some(item=>item.result.buckets.length),live:status.kind==='ready',n,countLabel:unitNoun(activeView(state))+' with finite paired values',
    stats:[{label:'Total',value:n?.toLocaleString('en-US')??'—',title:'Finite paired observations in this dashboard.'}],
    cohorts:panel.series.length ? cohorts.map((cohort,i)=>({id:cohort.id,name:cohort.name,color:color(i),
      n:results[i]?.buckets.reduce((sum,bucket)=>sum+bucket.n,0)??null,editable:false,descriptorKey:cohort.descriptorKey})):null,
    comparison:null,splitCohorts:[],outsideNotes:[],partial:false,
    analysisHeaders:['n',`First ${lowerLabel}`,'First median',`First ${upperLabel}`,`Last ${lowerLabel}`,'Last median',`Last ${upperLabel}`,'Median change'],analysisRows:rows,
    analysisNote:`${lowerLabel}, median and ${upperLabel} are shown for each series’ first and last occupied buckets. Faded buckets contain fewer than 20 observations.`,correlationPairs:[],
  };
}
