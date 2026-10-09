import { queryKey, type CorrelationResult, type Density2dResult } from '@mriqc/shared';
import { axisEvidence } from '../graph/axis-options';
import { valueScale } from '../panels/specs/palette';
import { clusterKey, panelCohorts, panelQueries, resultOf } from '../graph/queries';
import type { Panel, State } from '../graph/state';
import { isDerivedCohort } from '../graph/state';
import { densityChart, correlationChart, clustersChart, type AnalysisSeries } from '../panels/specs/analysis-charts';
import { fisherInterval } from '../panels/specs/analysis-math';
import { OTHER_COLOR, type ChartTheme } from '../panels/specs/palette';
import type { KMeansResult } from '../study/kmeans';
import type { PanelView, PanelStatus } from './panel-view';
import { activeView, analysisMeaning, metricDef, significant, unitNoun } from './text';

export interface AnalysisRow { id: string; name: string; color: string; cells: readonly string[] }

function correlationText(value: number | null, n: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const ci = fisherInterval(value, n);
  return `${value.toFixed(3)}${ci ? ` [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : ' [CI unavailable]'}`;
}

export function analysisPanelView(state: State, panel: Panel, theme: ChartTheme): PanelView {
  const queries = panelQueries(state, panel), keys = queries.map(queryKey);
  const cohorts = panelCohorts(state, panel);
  const ownResults = keys.slice(0, cohorts.length).map(key => resultOf<Density2dResult>(state, key));
  const results = keys.length > cohorts.length ? keys.slice(cohorts.length).map(key => resultOf<Density2dResult>(state, key)) : ownResults;
  const xMetric = metricDef(state, panel.x), yMetric = metricDef(state, panel.y);
  const x = xMetric?.shortLabel ?? xMetric?.label ?? String(panel.x);
  const y = yMetric?.shortLabel ?? yMetric?.label ?? String(panel.y);
  const noun = unitNoun(activeView(state));
  const xEvidence = axisEvidence(state, panel, 'x'), yEvidence = axisEvidence(state, panel, 'y');
  const series: AnalysisSeries[] = panel.chart === 'correlation' ? [] : cohorts.flatMap((cohort, index) => results[index] ? [{
    id: cohort.id, name: cohort.name, color: theme.categories[((cohort.color % 6) + 6) % 6], result: results[index]!,
  }] : []);
  const extraKey = clusterKey(state, panel);
  const allKeys = extraKey ? [...keys, extraKey] : keys;
  const failures = allKeys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures } :
    keys.length === 0 ? { kind: 'empty', message: 'Choose at least two available metrics.' } :
    allKeys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' } :
    { kind: 'ready', stale: allKeys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  let chart: ReturnType<typeof densityChart> | null = null;
  let headers: string[] = ['Cohort', 'n', 'Pearson r [95% CI]', 'Spearman ρ [95% CI]'];
  let rows: AnalysisRow[] = series.map(item => ({ id: item.id, name: item.name, color: item.color,
    cells: [item.result.n.toLocaleString('en-US'), correlationText(item.result.pearson, item.result.n), correlationText(item.result.spearman, item.result.n)] }));
  let note = '95% CIs use the Fisher transform. Drag a rectangle to filter the other panels.';
  let n = ownResults[0]?.n ?? null;
  let meaning = analysisMeaning(x, y, n, noun);
  let cells: Array<{ x: string; y: string; label: string }> = [];
  if (panel.chart === 'correlation') {
    const result = resultOf<CorrelationResult>(state, keys[0]);
    if (result) {
      const labels = Object.fromEntries(result.metrics.map(id => [id, metricDef(state, id)?.label ?? id]));
      chart = correlationChart(result, labels, panel.options.clusterOrder ?? false, theme, panel.options.coefficient ?? 'spearman');
      n = result.minPairN;
      cells = result.metrics.flatMap((a, i) => result.metrics.slice(i + 1).map(b => ({ x: a, y: b, label: `${labels[a]} × ${labels[b]}` })));
    }
    headers = []; rows = [];
    meaning = `+1: the two metrics always rise together. −1: one falls as the other rises. 0: unrelated. Over ${n?.toLocaleString('en-US') ?? '…'} scans with both values; click a pair to see its scatter.`;
    note = `Minimum pairwise n: ${n?.toLocaleString('en-US') ?? '…'}. Click a cell to inspect the pair.${cohorts.length > 1 ? ` Matrix: ${cohorts[0].name}.` : ''}`;
  } else if (panel.chart === 'clusters') {
    const clustering = extraKey ? resultOf<KMeansResult>(state, extraKey) : null;
    headers = ['Cluster', 'n', 'Share', `Median ${x}`, `Median ${y}`]; rows = [];
    if (clustering && ownResults[0]) {
      chart = clustersChart(ownResults[0].sample, clustering, x, y, theme);
      rows = clustering.clusters.map(cluster => ({ id: String(cluster.id), name: cluster.id >= 6 ? `Other (Cluster ${cluster.id + 1})` : `Cluster ${cluster.id + 1}`,
        color: cluster.id >= 6 ? OTHER_COLOR : theme.categories[cluster.id], cells: [cluster.n.toLocaleString('en-US'), `${(cluster.share * 100).toFixed(1)}%`, significant(cluster.medianX), significant(cluster.medianY)] }));
      const silhouette = clustering.silhouette === null ? 'undefined' : clustering.silhouette.toFixed(3);
      note = `Silhouette ${clustering.silhouetteApproximation ? '≈ ' : ''}${silhouette} · on a ${clustering.validPointCount === 20000 ? '20k' : clustering.validPointCount.toLocaleString('en-US')} sample, exploratory${clustering.silhouetteApproximation ? ` (${clustering.silhouetteSampleSize} evaluation points; ${clustering.silhouetteSampleCount} distance anchors)` : ''}.`;
    }
    meaning = `Exploratory clusters of ${x} and ${y}, on a sample of ${cohorts[0]?.name ?? 'this dashboard'}.`;
  } else if (series.length) {
    const ownX = state.selections.find(selection => selection.from === panel.id && selection.metric === panel.x);
    const ownY = state.selections.find(selection => selection.from === panel.id && selection.metric === panel.y);
    chart = densityChart(series, { xLabel: x, yLabel: y, chart: panel.chart === 'scatter' ? 'scatter' : panel.chart === 'hexbin' ? 'hexbin' : 'density2d', showPoints: panel.options.showPoints ?? false, theme, brushEnabled: true,
      xScale: valueScale(panel.options.xScale === 'log' && !xEvidence.positive ? 'symlog' : panel.options.xScale, panel.options.xRange, xEvidence.constant),
      yScale: valueScale(panel.options.yScale === 'log' && !yEvidence.positive ? 'symlog' : panel.options.yScale, panel.options.yRange, yEvidence.constant),
      brush: ownX && ownY ? { x: ownX.range, y: ownY.range } : undefined });
    if (series.length > 1) {
      const ref = series.find(s => s.id === panel.reference) ?? series[0];
      rows.push(...series.filter(s => s.id !== ref.id).map(item => ({ id: `difference-${item.id}`, name: `Δρ ${item.name} vs ${ref.name}`, color: item.color,
        cells: ['—', '—', item.result.spearman === null || ref.result.spearman === null ? '—' : (item.result.spearman - ref.result.spearman).toFixed(3)] })));
    }
    if (panel.chart === 'hexbin' || panel.chart === 'scatter') note += ' Marks show the retained point sample.';
  }
  return {
    xPositive: xEvidence.positive, yPositive: yEvidence.positive,
    id: panel.id, panel, title: panel.chart === 'correlation' ? 'Metric correlations' : `${x} × ${y}`,
    meaning, subtitle: '', notes: [], clipChip: panel.options.clip === 'p01p99' ? null : panel.options.clip === 'none' ? 'Full range' : 'p05–p95',
    metricHelp: xMetric ? { label: xMetric.label, taxonomy: xMetric.family, description: xMetric.description ?? null, unit: xMetric.unit ?? null } : null,
    specKey: JSON.stringify([theme.mode, panel, keys, chart?.spec]), spec: chart?.spec ?? null, datasets: chart?.datasets ?? {}, table: null, status,
    brushable: ['density2d', 'scatter', 'hexbin'].includes(panel.chart), hasRows: !!chart && Object.values(chart.datasets).some(values => values.length > 0), live: status.kind === 'ready', n,
    countLabel: `${noun} with paired values`, stats: null,
    cohorts: cohorts.length > 1 ? cohorts.map((cohort, i) => ({ id: cohort.id, name: cohort.name, color: series[i]?.color ?? theme.categories[i % 6],
      n: ownResults[i]?.n ?? null, editable: !isDerivedCohort(cohort.id) })) : null,
    comparison: null, splitCohorts: [], outsideNotes: [], partial: false,
    analysisHeaders: headers, analysisRows: rows, analysisNote: note, correlationPairs: cells,
  };
}
