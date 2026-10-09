import { queryKey, type BinnedSummaryResult } from '@mriqc/shared';
import { withChipLegend } from '../panels/specs/chip-legend';
import { binnedQueries, panelCohort, panelCohorts, panelQueries, resultOf, scopedQuery } from '../graph/queries';
import type { Panel, State } from '../graph/state';
import { bandChart, type BinnedSeries } from '../panels/specs/band';
import { axisEvidence } from '../graph/axis-options';
import { OTHER_COLOR, type ChartTheme } from '../panels/specs/palette';
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
    const base = scopedQuery(state, panel, cohort, 'binnedSummary');
    const query = base && binnedQueries(state, panel).filter(query => queryKey({ ...query, range: undefined }) === queryKey({ ...base, range: undefined } as typeof query)).at(-1);
    return query ? resultOf<BinnedSummaryResult>(state, queryKey(query)) : null;
  };
  const results = cohorts.map(resultFor);
  const failures = keys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures }
    : keys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' }
    : { kind: 'ready', stale: keys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  const metric = metricDef(state, panel.y), label = metric?.shortLabel ?? metric?.label ?? String(panel.y);
  const color = (index: number) => cohorts[index]?.name === 'Other' ? OTHER_COLOR : theme.categories[index % 6];
  const series: BinnedSeries[] = cohorts.flatMap((cohort,index) => results[index] ? [{
    id: cohort.id, name: cohort.name, color: color(index), result: results[index]!,
  }] : []);
  const time = panel.x === 'created_at';
  const xLabel = time ? 'Upload time' : metricDef(state, panel.x)?.label ?? String(panel.x);
  const evidence = axisEvidence(state, panel);
  const chart = bandChart(series, label, { label: xLabel, theme, logScale: false,
    xScale: time ? 'time' : panel.options.xScale === 'log' && !evidence.positive ? 'symlog' : panel.options.xScale,
    xRange: panel.options.xRange, constant: evidence.constant, granularity: panel.options.granularity, countTitle: 'Scans' }, panel.form === 'lines' ? 'lines' : 'band');
  const aggregate = resultFor(panelCohort(state,panel));
  const n = aggregate?.buckets.reduce((sum,bucket) => sum + bucket.n,0) ?? null;
  const rows = series.map(item => {
    const stats = timeSeriesStats(item);
    return { id:item.id, name:item.name,color:item.color,cells:[stats.n.toLocaleString('en-US'), ...[stats.first,stats.last,stats.change].map(value => significant(value))] };
  });
  return {
    id:panel.id,panel,title:time ? 'Uploads over time' : `${label} vs ${xLabel}`,meaning:label+' per '+xLabel+' bin: '+(panel.form === 'lines' ? '5th, 50th and 95th percentiles.' : 'median and middle half.'),subtitle:'',
    notes:panelNotes(state,panel),clipChip:null,
    metricHelp:metric ? {label:metric.label,taxonomy:metric.family,description:metric.description??null,unit:metric.unit??null}:null,
    specKey:JSON.stringify([theme.mode,panel.form,panel.x,panel.y,panel.options,series.map(item=>[item.id,item.name,item.color])]),
    spec:withChipLegend(chart.spec),datasets:chart.datasets,table:null,status,brushable:false,
    hasRows:series.some(item=>item.result.buckets.length),live:status.kind==='ready',n,countLabel:unitNoun(activeView(state))+' with finite paired values',
    stats:[{label:'Total',value:n?.toLocaleString('en-US')??'—',title:'Finite paired observations in this dashboard.'}],
    cohorts:panel.series.length ? cohorts.map((cohort,i)=>({id:cohort.id,name:cohort.name,color:color(i),
      n:results[i]?.buckets.reduce((sum,bucket)=>sum+bucket.n,0)??null,editable:false,descriptorKey:cohort.descriptorKey})):null,
    comparison:null,splitCohorts:[],outsideNotes:[],partial:false,
    analysisHeaders:cohorts.length>1?['n','First median','Last median','Change']:[],analysisRows:cohorts.length>1?rows:[],
    analysisNote:'Medians are shown for each series’ first and last occupied buckets. Faded buckets contain fewer than 20 observations.',correlationPairs:[],
  };
}
