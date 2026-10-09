import { queryKey, type TimeSummaryResult } from '@mriqc/shared';
import { withChipLegend } from '../panels/specs/chip-legend';
import { panelCohort, panelCohorts, panelQueries, resultOf, scopedQuery } from '../graph/queries';
import type { Panel, State } from '../graph/state';
import { medianBandChart, type TimeSeries } from '../panels/specs/median-band';
import { OTHER_COLOR, type ChartTheme } from '../panels/specs/palette';
import type { PanelStatus, PanelView } from './panel-view';
import { activeView, metricDef, panelNotes, significant, unitNoun } from './text';

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
  const resultFor = (cohort: typeof cohorts[number]) => {
    const query = scopedQuery(state, panel, cohort, 'timeSummary');
    return query ? resultOf<TimeSummaryResult>(state, queryKey(query)) : null;
  };
  const results = cohorts.map(resultFor);
  const failures = keys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures }
    : keys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' }
    : { kind: 'ready', stale: keys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  const metric = metricDef(state, panel.y), label = metric?.shortLabel ?? metric?.label ?? String(panel.y);
  const color = (index: number) => cohorts[index]?.name === 'Other' ? OTHER_COLOR : theme.categories[index % 6];
  const series: TimeSeries[] = cohorts.flatMap((cohort,index) => results[index] ? [{
    id: cohort.id, name: cohort.name, color: color(index), result: results[index]!,
  }] : []);
  const chart = medianBandChart(series,label,theme,panel.form === 'lines' ? 'lines' : 'band');
  const aggregate = resultFor(panelCohort(state,panel));
  const n = aggregate?.buckets.reduce((sum,bucket) => sum + bucket.n,0) ?? null;
  const rows = series.map(item => {
    const stats = timeSeriesStats(item);
    return { id:item.id, name:item.name,color:item.color,cells:[stats.n.toLocaleString('en-US'), ...[stats.first,stats.last,stats.change].map(value => significant(value))] };
  });
  return {
    id:panel.id,panel,title:'Uploads over time',meaning:label+' over upload time: median and middle half.',subtitle:'',
    notes:panelNotes(state,panel),clipChip:null,
    metricHelp:metric ? {label:metric.label,taxonomy:metric.family,description:metric.description??null,unit:metric.unit??null}:null,
    specKey:JSON.stringify([theme.mode,panel.form,panel.y,panel.options.granularity,series.map(item=>[item.id,item.name,item.color])]),
    spec:withChipLegend(chart.spec),datasets:chart.datasets,table:null,status,brushable:false,
    hasRows:series.some(item=>item.result.buckets.length),live:status.kind==='ready',n,countLabel:unitNoun(activeView(state))+' with dated finite values',
    stats:[{label:'Total',value:n?.toLocaleString('en-US')??'—',title:'Dated finite observations in this dashboard.'}],
    cohorts:panel.series.length ? cohorts.map((cohort,i)=>({id:cohort.id,name:cohort.name,color:color(i),
      n:results[i]?.buckets.reduce((sum,bucket)=>sum+bucket.n,0)??null,editable:false,descriptorKey:cohort.descriptorKey})):null,
    comparison:null,splitCohorts:[],outsideNotes:[],partial:false,
    analysisHeaders:cohorts.length>1?['n','First median','Last median','Change']:[],analysisRows:cohorts.length>1?rows:[],
    analysisNote:'Medians are shown for each series’ first and last occupied buckets. Faded buckets contain fewer than 20 observations.',correlationPairs:[],
  };
}
