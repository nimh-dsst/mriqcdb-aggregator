import { queryKey, type CorrelationResult, type Density2dResult } from '@mriqc/shared';
import { axisEvidence } from '../graph/axis-options';
import { valueScale } from '../panels/specs/palette';
import { clusterKeys, panelCohorts, panelQueries, resultOf } from '../graph/queries';
import type { Panel, State } from '../graph/state';
import { isDerivedCohort } from '../graph/state';
import { densityChart, correlationChart, clustersChart, type AnalysisSeries } from '../panels/specs/analysis-charts';
import { fisherInterval } from '../panels/specs/analysis-math';
import { OTHER_COLOR, type ChartTheme } from '../panels/specs/palette';
import type { KMeansResult } from '../study/kmeans';
import type { PanelView, PanelStatus } from './panel-view';
import { activeView, analysisMeaning, metricDef, significant, unitNoun } from './text';
import { baseConfig } from '../panels/specs/palette';
import type { TopLevelSpec } from 'vega-lite';

export interface AnalysisRow { id: string; name: string; color: string; cells: readonly string[] }

/** Small multiples preserve each series' analysis and one shared chip legend. */
function analysisFacets(items: Array<{ id: string; name: string; chart: ReturnType<typeof densityChart> }>, theme: ChartTheme) {
  if (items.length === 1) return items[0].chart;
  const datasets: Record<string, readonly unknown[]> = {};
  const concat = items.map((item, index) => {
    const names = new Map(Object.keys(item.chart.datasets).map(name => [name, `${name}-${index}`]));
    for (const [name, rows] of Object.entries(item.chart.datasets)) {
      datasets[names.get(name)!] = rows.map(row => ({ ...(row as object), seriesId: item.id }));
    }
    const spec = structuredClone(item.chart.spec) as unknown as Record<string, unknown>;
    const rename = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(rename); return; }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const data = record['data'] as { name?: string } | undefined;
      if (data?.name && names.has(data.name)) data.name = names.get(data.name);
      Object.values(record).forEach(rename);
    };
    rename(spec);
    for (const key of ['$schema', 'config', 'autosize', 'background']) delete spec[key];
    return { ...spec, title: item.name, width: 200, height: 200 };
  });
  return { datasets, spec: { ...baseConfig(theme), concat, columns: 2 } as unknown as TopLevelSpec };
}

function correlationText(value: number | null, n: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const ci = fisherInterval(value, n);
  return `${value.toFixed(3)}${ci ? ` [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : ' [CI unavailable]'}`;
}

export function analysisPanelView(state: State, panel: Panel, theme: ChartTheme): PanelView {
  const queries = panelQueries(state, panel), keys = queries.map(queryKey);
  const cohorts = panelCohorts(state, panel);
  const densityKeys = queries.filter(query => query.proc === 'density2d').map(queryKey);
  const ownResults = densityKeys.slice(0, cohorts.length).map(key => resultOf<Density2dResult>(state, key));
  const results = densityKeys.length > cohorts.length ? densityKeys.slice(cohorts.length).map(key => resultOf<Density2dResult>(state, key)) : ownResults;
  const xMetric = metricDef(state, panel.x), yMetric = metricDef(state, panel.y);
  const x = xMetric?.shortLabel ?? xMetric?.label ?? String(panel.x);
  const y = yMetric?.shortLabel ?? yMetric?.label ?? String(panel.y);
  const noun = unitNoun(activeView(state));
  const xEvidence = axisEvidence(state, panel, 'x'), yEvidence = axisEvidence(state, panel, 'y');
  const series: AnalysisSeries[] = panel.form === 'matrix' ? [] : cohorts.flatMap((cohort, index) => results[index] ? [{
    id: cohort.id, name: cohort.name, color: theme.categories[((cohort.color % 6) + 6) % 6], result: results[index]!,
  }] : []);
  const extraKeys = clusterKeys(state, panel);
  const allKeys = [...keys, ...extraKeys];
  const failures = allKeys.filter(key => state.datasets[key]?.status === 'error');
  const status: PanelStatus = failures.length ? { kind: 'error', message: (state.datasets[failures[0]] as { error: string }).error, retryKeys: failures } :
    keys.length === 0 ? { kind: 'empty', message: 'Choose at least two available metrics.' } :
    allKeys.some(key => state.datasets[key]?.status !== 'ready') ? { kind: 'loading' } :
    { kind: 'ready', stale: allKeys.some(key => state.datasets[key]?.version !== state.dataVersion) };
  let chart: ReturnType<typeof densityChart> | null = null;
  let headers: string[] = ['n', 'Pearson r [95% CI]', 'Spearman ρ [95% CI]'];
  let rows: AnalysisRow[] = series.map(item => ({ id: item.id, name: item.name, color: item.color,
    cells: [item.result.n.toLocaleString('en-US'), correlationText(item.result.pearson, item.result.n), correlationText(item.result.spearman, item.result.n)] }));
  let note = '95% CIs use the Fisher transform. Drag a rectangle to filter the other panels.';
  let n = ownResults[0]?.n ?? null;
  let meaning = analysisMeaning(x, y, n, noun);
  let cells: Array<{ x: string; y: string; label: string }> = [];
  if (panel.form === 'matrix') {
    const result = resultOf<CorrelationResult>(state, keys[0]);
    if (result) {
      const labels = Object.fromEntries(result.metrics.map(id => [id, metricDef(state, id)?.label ?? id]));
      const matrices = cohorts.flatMap((cohort, index) => {
        const data = resultOf<CorrelationResult>(state, keys[index]);
        if (!data) return [];
        const names = Object.fromEntries(data.metrics.map(id => [id, metricDef(state, id)?.label ?? id]));
        return [{ id: cohort.id, name: cohort.name, chart: correlationChart(data, names, panel.options.clusterOrder ?? false, theme, panel.options.coefficient ?? 'spearman') }];
      });
      chart = analysisFacets(matrices, theme);
      n = result.minPairN;
      cells = result.metrics.flatMap((a, i) => result.metrics.slice(i + 1).map(b => ({ x: a, y: b, label: `${labels[a]} × ${labels[b]}` })));
    }
    headers = ['Minimum paired n'];
    rows = cohorts.length > 1 ? cohorts.map((cohort, index) => ({ id: cohort.id, name: cohort.name, color: theme.categories[cohort.color % 6],
      cells: [resultOf<CorrelationResult>(state, keys[index])?.minPairN.toLocaleString('en-US') ?? '—'] })) : [];
    meaning = `+1: the two metrics always rise together. −1: one falls as the other rises. 0: unrelated. Over ${n?.toLocaleString('en-US') ?? '…'} scans with both values; click a pair to see its scatter.`;
    note = `Minimum pairwise n: ${n?.toLocaleString('en-US') ?? '…'}. Click a cell to inspect the pair.`;
  } else if (panel.form === 'clusters') {
    const clustering = extraKeys[0] ? resultOf<KMeansResult>(state, extraKeys[0]) : null;
    headers = ['n', 'Share', `Median ${x}`, `Median ${y}`]; rows = [];
    if (clustering && ownResults[0]) {
      chart = analysisFacets(cohorts.flatMap((cohort, index) => {
        const fitted = resultOf<KMeansResult>(state, extraKeys[index]);
        return fitted && ownResults[index] ? [{ id: cohort.id, name: cohort.name,
          chart: clustersChart(ownResults[index]!.sample, fitted, x, y, theme) }] : [];
      }), theme);
      rows = cohorts.flatMap((cohort, index) => (resultOf<KMeansResult>(state, extraKeys[index])?.clusters ?? []).map(cluster => ({
        id: `${cohort.id}-${cluster.id}`, name: `${cohorts.length > 1 ? cohort.name + ': ' : ''}${cluster.id >= 6 ? `Other (Cluster ${cluster.id + 1})` : `Cluster ${cluster.id + 1}`}`,
        color: cluster.id >= 6 ? OTHER_COLOR : theme.categories[cluster.id], cells: [cluster.n.toLocaleString('en-US'), `${(cluster.share * 100).toFixed(1)}%`, significant(cluster.medianX), significant(cluster.medianY)] })));
      const silhouette = clustering.silhouette === null ? 'undefined' : clustering.silhouette.toFixed(3);
      note = `Silhouette ${clustering.silhouetteApproximation ? '≈ ' : ''}${silhouette} · on a ${clustering.validPointCount === 20000 ? '20k' : clustering.validPointCount.toLocaleString('en-US')} sample, exploratory${clustering.silhouetteApproximation ? ` (${clustering.silhouetteSampleSize} evaluation points; ${clustering.silhouetteSampleCount} distance anchors)` : ''}.`;
    }
    meaning = `Exploratory clusters of ${x} and ${y}, on a sample ${cohorts.length > 1 ? 'for each series' : 'of ' + (cohorts[0]?.name ?? 'this dashboard')}.`;
  } else if (series.length) {
    const ownX = state.selections.find(selection => selection.from === panel.id && selection.metric === panel.x);
    const ownY = state.selections.find(selection => selection.from === panel.id && selection.metric === panel.y);
    chart = densityChart(series, { xLabel: x, yLabel: y, form: panel.form === 'scatter' ? 'scatter' : panel.form === 'hexbin' ? 'hexbin' : 'heatmap', showPoints: panel.options.showPoints ?? false, theme, brushEnabled: true,
      xScale: valueScale(panel.options.xScale === 'log' && !xEvidence.positive ? 'symlog' : panel.options.xScale, panel.options.xRange, xEvidence.constant),
      yScale: valueScale(panel.options.yScale === 'log' && !yEvidence.positive ? 'symlog' : panel.options.yScale, panel.options.yRange, yEvidence.constant),
      brush: ownX && ownY ? { x: ownX.range, y: ownY.range } : undefined });
    if (series.length > 1) {
      const ref = series.find(s => s.id === panel.reference) ?? series[0];
      rows.push(...series.filter(s => s.id !== ref.id).map(item => ({ id: `difference-${item.id}`, name: `Δρ ${item.name} vs ${ref.name}`, color: item.color,
        cells: ['—', '—', item.result.spearman === null || ref.result.spearman === null ? '—' : (item.result.spearman - ref.result.spearman).toFixed(3)] })));
    }
    if (panel.form === 'hexbin' || panel.form === 'scatter') note += ' Marks show the retained point sample.';
  }
  return {
    xPositive: xEvidence.positive, yPositive: yEvidence.positive,
    id: panel.id, panel, title: panel.form === 'matrix' ? 'Metric correlations' : `${x} × ${y}`,
    meaning, subtitle: '', notes: [], clipChip: panel.options.clip === 'p01p99' ? null : panel.options.clip === 'none' ? 'Full range' : 'p05–p95',
    metricHelp: xMetric ? { label: xMetric.label, taxonomy: xMetric.family, description: xMetric.description ?? null, unit: xMetric.unit ?? null } : null,
    specKey: JSON.stringify([theme.mode, panel, keys, chart?.spec]), spec: chart?.spec ?? null, datasets: chart?.datasets ?? {}, table: null, status,
    brushable: ['heatmap', 'scatter', 'hexbin'].includes(panel.form), hasRows: !!chart && Object.values(chart.datasets).some(values => values.length > 0), live: status.kind === 'ready', n,
    countLabel: `${noun} with paired values`, stats: null,
    cohorts: cohorts.length > 1 ? cohorts.map((cohort, i) => ({ id: cohort.id, name: cohort.name, color: series[i]?.color ?? theme.categories[i % 6],
      n: panel.form === 'matrix' ? resultOf<CorrelationResult>(state, keys[i])?.minPairN ?? null : ownResults[i]?.n ?? null,
      editable: !isDerivedCohort(cohort.id), descriptorKey: cohort.descriptorKey })) : null,
    comparison: null, splitCohorts: [], outsideNotes: [], partial: false,
    analysisHeaders: headers, analysisRows: rows, analysisNote: note, correlationPairs: cells,
  };
}
