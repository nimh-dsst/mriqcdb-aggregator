import { asColumnId, getAuthoredCatalog, isValidField, isValidMetric, metricsFor, fieldsFor, type Modality, type PanelKind, type View } from '@mriqc/shared';
import { isKnownCohortId, validCohortList } from './cohorts';
import type { PanelPatch } from './commands';
import { evict } from './datasets';
import { chartsFor, defaultChartFor, shapeOf, validChart } from './panel-shapes';
import { CURRENT_COHORT, FIRST_PAGE, defaultPanelOptions, type CohortId, type MetricId, type Panel, type PanelId, type PanelOptions, type State } from './state';
import { clampBins } from './url-tokens';

export function revertToDistribution(panel: Panel): Panel {
  const { reference: _, ...rest } = panel;
  return validChart({ ...rest, split: null, cohorts: [CURRENT_COHORT], cursors: FIRST_PAGE });
}

export function pruneCohortRefs(panels: readonly Panel[], state: State): readonly Panel[] {
  return panels.map(panel => {
    const ids = validCohortList(panel.cohorts, state);
    const cohorts = ids.length ? ids : [CURRENT_COHORT];
    if (cohorts.length === panel.cohorts.length && cohorts.every((id, i) => id === panel.cohorts[i]) &&
      (panel.reference === undefined || cohorts.includes(panel.reference))) return panel;
    const { reference, ...rest } = panel;
    return validChart({ ...rest, cohorts, ...(reference && cohorts.includes(reference) ? { reference } : {}) });
  });
}

export function pruneSelection(state: State): State {
  const selections = state.selections.filter(selection => {
    const origin = state.panels.find(panel => panel.id === selection.from);
    return origin && [origin.x, origin.y].includes(selection.metric) &&
      ['histogram', 'density', 'ecdf', 'density2d', 'scatter', 'hexbin', 'clusters'].includes(origin.chart) &&
      (origin.y !== null || origin.split === null);
  });
  return selections.length === state.selections.length ? state : { ...state, selections };
}

function firstMetric(modality: Modality): MetricId { return metricsFor(modality)[0]?.id ?? asColumnId('fd_mean'); }

export function newPanel(state: State, kind: PanelKind = 'distribution', metric?: MetricId, cohorts?: readonly CohortId[]): Panel {
  const { modality, view } = state.global;
  const chosen = metric && isValidMetric(modality, metric) ? metric : firstMetric(modality);
  const taken = new Set(state.panels.map(panel => panel.id));
  const max = Math.max(0, ...state.panels.map(panel => /^p\d+$/.test(panel.id) && Number.isSafeInteger(Number(panel.id.slice(1))) ? Number(panel.id.slice(1)) : 0));
  let id = max + 1; while (taken.has(`p${id}`)) id++;
  const asked = validCohortList(cohorts, state);
  const panel: Panel = { id: `p${id}`, x: kind === 'coverage' ? 'created_at' : chosen, y: null,
    split: kind === 'coverage' || kind === 'grouped' ? (fieldsFor(modality, view, 'group').find(f => f.id === 'manufacturer')?.id ?? null) : null,
    cohorts: kind === 'comparison' ? asked.length >= 2 ? asked : ['current', 'all'] : ['current'],
    chart: kind === 'sample' ? 'table' : 'histogram',
    options: defaultPanelOptions(metricsFor(modality).find(m => m.id === chosen)?.clipDefault), cursors: FIRST_PAGE };
  return { ...panel, chart: kind === 'sample' ? 'table' : defaultChartFor(shapeOf(panel)) };
}

export function mapPanel(state: State, id: PanelId, f: (panel: Panel) => Panel): State {
  let changed = false;
  const panels = state.panels.map(panel => { if (panel.id !== id) return panel; const next = f(panel); changed ||= next !== panel; return next; });
  return changed ? { ...state, panels } : state;
}

function retargetMetric(metric: MetricId, modality: Modality): MetricId {
  if (isValidMetric(modality, metric)) return metric;
  const family = getAuthoredCatalog().metrics.find(m => m.id === metric)?.family;
  return metricsFor(modality).find(m => m.family === family)?.id ?? firstMetric(modality);
}

export function retargetPanels(panels: readonly Panel[], modality: Modality, view: View): readonly Panel[] {
  return panels.map(panel => {
    const x = panel.x === 'created_at' ? panel.x : retargetMetric(panel.x, modality);
    const candidateY = panel.y === null ? null : retargetMetric(panel.y, modality);
    const y = candidateY === x ? null : candidateY;
    const split = panel.split && isValidField(modality, view, panel.split, 'group') ? panel.split : null;
    if (x === panel.x && y === panel.y && split === panel.split) return panel;
    return validChart({ ...panel, x, y, split, cursors: FIRST_PAGE });
  });
}

export function normalizedOptions(panel: Panel, patch: Partial<PanelOptions>, modality?: Modality): PanelOptions {
  const options = { ...defaultPanelOptions(), ...panel.options, ...patch };
  const legacy = options as PanelOptions & { logScale?: boolean };
  if (legacy.logScale === true && !('xScale' in panel.options)) options.xScale = 'log';
  delete legacy.logScale;
  for (const key of ['xScale', 'yScale'] as const) if (!['linear', 'log', 'symlog'].includes(options[key])) options[key] = 'linear';
  for (const key of ['xRange', 'yRange'] as const) {
    const range = options[key];
    options[key] = Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] !== range[1]
      ? [Math.min(...range), Math.max(...range)] : 'auto';
  }
  if (!['count', 'share', 'logCount'].includes(options.yMode)) options.yMode = 'count';
  if (!panel.split || panel.cohorts.length > 1 || !['stacked', 'stacked100'].includes(options.layout)) options.layout = 'overlaid';
  if (options.coefficient !== undefined) options.coefficient = options.coefficient === 'pearson' ? 'pearson' : 'spearman';
  options.bins = clampBins(options.bins);
  options.splitPresentation = options.splitPresentation === 'facets' ? 'facets' : 'overlay';
  if (!['12m', '5y', 'custom'].includes(options.coverageWindow)) options.coverageWindow = 'all';
  if (!Array.isArray(options.coverageCustom) || options.coverageCustom.length !== 2 || !options.coverageCustom.every(d => typeof d === 'string')) options.coverageCustom = null;
  else if (options.coverageCustom[0] > options.coverageCustom[1]) options.coverageCustom = [options.coverageCustom[1], options.coverageCustom[0]];
  options.boxSort = options.boxSort === 'n' ? 'n' : 'median';
  for (const key of ['cumulative','share','coverageLogY'] as const) options[key] = options[key] === true;
  if (options.k !== undefined) options.k = Math.max(2, Math.min(8, Math.round(Number(options.k)) || 3));
  if (options.seed !== undefined) options.seed = Math.max(0, Math.min(2147483647, Math.round(Number(options.seed)) || 0));
  if (options.sampleSize !== undefined) options.sampleSize = Math.max(1, Math.min(20000, Math.round(Number(options.sampleSize)) || 20000));
  if (options.metrics !== undefined) options.metrics = Array.isArray(options.metrics) ? [...new Set(options.metrics)].filter(m => typeof m === 'string' && (!modality || isValidMetric(modality, m))).slice(0,24) : [];
  if (options.family !== undefined && typeof options.family !== 'string') delete options.family;
  for (const key of ['showPoints','clusterOrder','clusterSplit'] as const) if (options[key] !== undefined) options[key] = options[key] === true;
  return options;
}

export function patchPanel(state: State, id: PanelId, patch: PanelPatch): State {
  let notice: string | null = null;
  const next = mapPanel(state, id, panel => {
    let current = panel;
    const x = patch.x ?? patch.metric;
    if (x !== undefined && (x === 'created_at' || isValidMetric(state.global.modality, x))) current = { ...current, x };
    if (patch.y !== undefined && (patch.y === null || isValidMetric(state.global.modality, patch.y))) current = { ...current, y: patch.y };
    const split = patch.split !== undefined ? patch.split : patch.group;
    if (split !== undefined) {
      if (split !== null && current.cohorts.length > 1) {
        notice = 'A split cannot be combined with multiple cohorts. Remove the extra cohorts first.';
      } else {
        const nextSplit = split && isValidField(state.global.modality, state.global.view, split, 'group') ? split : null;
        const startsSplit = current.split === null && nextSplit !== null && current.x !== 'created_at' && current.y === null;
        current = { ...current, split: nextSplit,
          ...(startsSplit && !patch.chart && ['histogram', 'ecdf'].includes(current.chart) ? { chart: 'density' as const } : {}) };
      }
    }
    if (patch.cohort !== undefined && isKnownCohortId(state, patch.cohort)) current = { ...current, cohorts: [patch.cohort] };
    if (patch.options) current = { ...current, options: normalizedOptions(current, patch.options, state.global.modality) };
    if (patch.chart) current = { ...current, chart: patch.chart };
    if (current.options.layout !== 'overlaid' && (!current.split || current.cohorts.length > 1)) current = { ...current, options: { ...current.options, layout: 'overlaid' } };
    if (current.options.layout !== 'overlaid' && current.chart === 'density') {
      current = { ...current, chart: 'histogram' };
    }
    if (patch.reference && current.cohorts.includes(patch.reference)) {
      current = { ...current, reference: patch.reference === current.cohorts[0] ? undefined : patch.reference };
    }
    if (current.x === current.y) {
      notice = 'Choose two different metrics.';
      return panel;
    }
    if (current.x !== 'created_at' && current.y !== null && current.split !== null) {
      current = { ...current, split: null };
      notice = 'The categorical split was removed. Compare cohorts to overlay two-metric distributions.';
    }
    if (current.options.clusterSplit && current.chart !== 'clusters') current = { ...current, options: { ...current.options, clusterSplit: false } };
    current = validChart(current);
    if (current.chart === 'clusters') current = { ...current, options: { ...current.options,
      k: current.options.k ?? 3, seed: current.options.seed ?? 42, sampleSize: current.options.sampleSize ?? 20000 } };
    return JSON.stringify(current) === JSON.stringify(panel) ? panel : { ...current, cursors: FIRST_PAGE };
  });
  if (next === state) return notice ? { ...state, notice } : state;
  return evict(pruneSelection({ ...next, notice }));
}
