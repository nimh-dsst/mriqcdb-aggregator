import { queryKey } from '../api/api';
import { type BinnedSummaryResult } from '@mriqc/shared';
import { withChipLegend } from '../panels/specs/chip-legend';
import { binnedQueries, countBandQuery, isCountBand, panelCohort, panelCohorts, panelQueries, resultOf, scopedQuery } from '../graph/queries';
import { countBand, fineGranularity } from '../graph/count-band';
import type { CoverageResult } from '@mriqc/shared';
import type { Panel, State } from '../graph/state';
import { bandChart, type BinnedSeries } from '../panels/specs/band';
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
  const countBandOf = (cohort: typeof cohorts[number]) => {
    const query = countBandQuery(state, panel, cohort);
    const coverage = query ? resultOf<CoverageResult>(state, queryKey(query)) : null;
    return coverage ? countBand(coverage, panel.options.granularity) : null;
  };
  const resultFor = (cohort: typeof cohorts[number]) => {
    if (isCountBand(panel)) return countBandOf(cohort);
    const base = scopedQuery(state, panel, cohort, 'binnedSummary');
    const query = base && binnedQueries(state, panel).filter(query => queryKey({ ...query, range: undefined }) === queryKey({ ...base, range: undefined } as typeof query)).at(-1);
    return query ? resultOf<BinnedSummaryResult>(state, queryKey(query)) : null;
  };
  const results = cohorts.map(resultFor);
  const failures = keys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures }
    : keys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' }
    : { kind: 'ready', stale: keys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  const metric = metricDef(state, panel.y);
  const label = isCountBand(panel) ? `Scans per ${fineGranularity(panel.options.granularity)}`
    : panel.y === 'created_at' ? 'Upload time' : metric?.shortLabel ?? metric?.label ?? String(panel.y);
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
  const chart = bandChart(series, label, { label: xLabel, theme, logScale: false,
    xScale: time ? 'time' : panel.options.xScale === 'log' && !evidence.positive ? 'symlog' : panel.options.xScale,
    xRange: panel.options.xRange, constant: evidence.constant, granularity: panel.options.granularity, countTitle: 'Scans' }, panel.form === 'lines' ? 'lines' : 'band', panel.options.quantiles,
    valueScale(panel.options.yScale, panel.options.yRange));
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
    id:panel.id,panel,title:time ? `${label} over time` : `${label} vs ${xLabel}`,meaning:label+' per '+xLabel+' bin: '+(panel.form === 'lines' ? `${lowerLabel}, median and ${upperLabel} lines.` : `median and ${lowerLabel}–${upperLabel} band.`),subtitle:'',
    notes:panelNotes(state,panel),clipChip:null,
    metricHelp:metric ? {label:metric.label,taxonomy:metric.family,description:metric.description??null,unit:metric.unit??null}:null,
    specKey:JSON.stringify([theme.mode,panel.form,panel.x,panel.y,panel.options,series.map(item=>[item.id,item.name,item.color])]),
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
