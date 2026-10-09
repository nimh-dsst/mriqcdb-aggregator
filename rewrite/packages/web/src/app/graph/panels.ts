import { asColumnId, getAuthoredCatalog, isValidField, isValidMetric, metricsFor, type Modality, type View } from '@mriqc/shared';
import { evict } from './datasets';
import { panelCohorts } from './queries';
import type { PanelPatch } from './commands';
import { axisType, formsFor, panelFormAvailability, validForm, brushable } from './panel-shapes';
import { normalizeSeries, seriesDisabledReason, seriesKey, type Series } from './series';
import { FIRST_PAGE, defaultPanelOptions, type ColumnRef, type Panel, type PanelId, type PanelOptions, type State } from './state';
import { clampBins } from './url-tokens';

export function seriesContext(state: State) {
  return {
    fieldCount: (field: string) => state.catalog?.fieldValues?.[field]?.[state.global.modality]?.[state.global.view]?.length ?? 5,
    studyReady: typeof state.study === 'object' && state.study.status === 'ready',
    cohortIds: state.cohorts.map(cohort => cohort.id),
  };
}

export function canStack(panel: Pick<Panel, 'series'>): boolean {
  return panel.series.length === 1 && ['field', 'values'].includes(panel.series[0].kind);
}

export function revertToDistribution(panel: Panel): Panel {
  const { reference: _, ...rest } = panel;
  return { ...rest, series: [], cursors: FIRST_PAGE };
}

export function pruneCohortRefs(panels: readonly Panel[], state: State): readonly Panel[] {
  return panels.map(panel => {
    const series = normalizeSeries(panel.series, { ...seriesContext(state), fieldCount: () => 0 });
    const next = pruneReference(state, { ...panel, series });
    return JSON.stringify(next) === JSON.stringify(panel) ? panel : next;
  });
}

function pruneReference(state: State, panel: Panel): Panel {
  const ids = panelCohorts(state, panel).map(cohort => cohort.id);
  if (panel.reference && (!ids.includes(panel.reference) || panel.reference === ids[0])) {
    const { reference: _, ...rest } = panel;
    return rest;
  }
  return panel;
}

export function pruneSelection(state: State): State {
  const selections = state.selections.filter(selection => {
    const origin = state.panels.find(panel => panel.id === selection.from);
    return origin && [origin.x, origin.y].includes(selection.metric) && brushable(origin);
  });
  return selections.length === state.selections.length ? state : { ...state, selections };
}

function firstMetric(modality: Modality) { return metricsFor(modality)[0]?.id ?? asColumnId('fd_mean'); }
export function validColumn(x: ColumnRef, modality: Modality, view: View): boolean {
  return x === 'created_at' || isValidMetric(modality, x) ||
    (axisType(x) === 'categorical' && isValidField(modality, view, x, 'group'));
}

export function newPanel(state: State, x?: ColumnRef): Panel {
  const { modality, view } = state.global;
  const chosen = x && validColumn(x, modality, view) ? x : firstMetric(modality);
  const taken = new Set(state.panels.map(panel => panel.id));
  const numbers = state.panels.map(panel => /^p\d+$/.test(panel.id) ? Number(panel.id.slice(1)) : 0)
    .filter(n => Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER);
  let n = Math.max(0, ...numbers) + 1;
  while (taken.has('p' + n)) n++;
  return { id: 'p' + n, x: chosen, y: null, series: [], form: formsFor(chosen, null)[0],
    options: defaultPanelOptions(metricsFor(modality).find(metric => metric.id === chosen)?.clipDefault), cursors: FIRST_PAGE };
}

export function mapPanel(state: State, id: PanelId, f: (panel: Panel) => Panel): State {
  let changed = false;
  const panels = state.panels.map(panel => { if (panel.id !== id) return panel; const next = f(panel); changed ||= next !== panel; return next; });
  return changed ? { ...state, panels } : state;
}

export function retargetPanels(panels: readonly Panel[], modality: Modality, view: View): readonly Panel[] {
  const retarget = (x: ColumnRef) => {
    if (validColumn(x, modality, view)) return x;
    const family = getAuthoredCatalog().metrics.find(metric => metric.id === x)?.family;
    return metricsFor(modality).find(metric => metric.family === family)?.id ?? firstMetric(modality);
  };
  return panels.map(panel => {
    const x = retarget(panel.x);
    const targetY = panel.y === null ? null : retarget(panel.y);
    const y = targetY === x || axisType(x) === 'categorical' ? null : targetY as Panel['y'];
    const series = panel.series.filter(item => !('field' in item) || isValidField(modality, view, item.field, 'group'));
    return validForm({ ...panel, x, y, series, cursors: FIRST_PAGE });
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
  options.quantiles = options.quantiles === 'tails' ? 'tails' : 'quartiles';
  if (!canStack(panel) || !['stacked', 'stacked100'].includes(options.layout)) options.layout = 'overlaid';
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
    if (x !== undefined && validColumn(x, state.global.modality, state.global.view)) {
      current = { ...current, x, ...(axisType(x) === 'categorical' ? { y: null } : {}) };
      if (x !== panel.x && panel.form === 'matrix') current = { ...current, form: formsFor(x, current.y)[0] };
    }
    if (patch.y !== undefined && axisType(current.x) !== 'categorical' &&
        (patch.y === null || patch.y === 'created_at' || isValidMetric(state.global.modality, patch.y))) current = { ...current, y: patch.y };
    if (current.x === current.y) { notice = 'Choose two different columns.'; return panel; }
    // A one-slot pick uses the default orientation; explicit axes (including swap) are kept.
    if (x === undefined && patch.y === 'created_at' && current.y === 'created_at' && panel.y !== 'created_at') {
      current = { ...current, x: 'created_at', y: current.x as Panel['y'] };
    }
    const group = patch.split !== undefined ? patch.split : patch.group;
    const requestedSeries = patch.series ?? (group !== undefined ? [
      ...current.series.filter(series => !('field' in series)),
      ...(group ? [{ kind: 'field' as const, field: group }] : []),
    ] : undefined);
    if (requestedSeries !== undefined) current = { ...current, series: normalizeSeries(requestedSeries, seriesContext(state)) };
    if (patch.options) current = { ...current, options: normalizedOptions(current, patch.options, state.global.modality) };
    if (patch.form) {
      // Creating a metric-set quantity is explicit; selecting a form cannot add axes.
      const quantity = patch.form === 'matrix' && patch.options?.metrics
        ? { ...current, form: patch.form } : current;
      if (panelFormAvailability(quantity).some(entry => entry.form === patch.form && entry.state === 'enabled')) {
        current = { ...current, form: patch.form };
      }
    }
    if (!canStack(current) && current.options.layout !== 'overlaid') current = { ...current, options: { ...current.options, layout: 'overlaid' } };
    if (current.options.layout !== 'overlaid' && current.form === 'density') current = { ...current, form: 'histogram' };
    current = validForm(current);
    if (current.form === 'clusters') current = { ...current, options: { ...current.options,
      k: current.options.k ?? 3, seed: current.options.seed ?? 42, sampleSize: current.options.sampleSize ?? 20000 } };
    if (patch.reference && panelCohorts(state, current).some(cohort => cohort.id === patch.reference)) current = { ...current, reference: patch.reference };
    current = pruneReference(state, current);
    return JSON.stringify(current) === JSON.stringify(panel) ? panel : { ...current, cursors: FIRST_PAGE };
  });
  return next === state ? notice ? { ...state, notice } : state : evict(pruneSelection({ ...next, notice }));
}

export function addSeries(state: State, id: PanelId, series: Series): State {
  const panel = state.panels.find(panel => panel.id === id);
  if (!panel) return state;
  if ('field' in series && !isValidField(state.global.modality, state.global.view, series.field, 'group')) return state;
  const reason = seriesDisabledReason(panel.series, series, seriesContext(state));
  return reason ? { ...state, notice: reason } : patchPanel(state, id, { series: [...panel.series, series] });
}

export function removeSeries(state: State, id: PanelId, key: string): State {
  const panel = state.panels.find(panel => panel.id === id);
  return panel ? patchPanel(state, id, { series: panel.series.filter(series => seriesKey(series) !== key) }) : state;
}
