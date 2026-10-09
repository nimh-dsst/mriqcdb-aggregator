import { expectTypeOf } from 'vitest';
import { optionPatch, optionValues, type PanelOptions as RegistryOptions } from './options';
import { options as histogramOptions } from './histogram/options';
import { asColumnId, isValidMetric, type Modality } from '@mriqc/shared';
import { defaultPanelOptions, type Panel, type PanelOptions } from '../graph/state';
import { normalizedOptions, canStack } from '../slices/panels/model';
import { clampBins } from '../codec/tokens';
import { FORM_ORDER } from './registry';
import { defaultDashboard } from '../slices/panels/defaults';

// Behavior oracle captured before moving validation to form schemas.
function beforeRegistry(panel: Panel, patch: Partial<PanelOptions>, modality?: Modality): PanelOptions {
  const options = { ...defaultPanelOptions(), ...panel.options, ...patch };
  const legacy = options as PanelOptions & { logScale?: boolean };
  if (legacy.logScale === true && !('xScale' in panel.options)) options.xScale = 'log';
  delete legacy.logScale;
  if (options.colorScale !== undefined && !['linear', 'log', 'sqrt'].includes(options.colorScale)) delete options.colorScale;
  if (options.cells !== undefined && ![30, 60, 120].includes(options.cells)) delete options.cells;
  if (options.colorDomain !== undefined) {
    const domain = options.colorDomain;
    options.colorDomain = Array.isArray(domain) && domain.length === 2 && domain.every(Number.isFinite) && domain[0] < domain[1]
      ? [domain[0], domain[1]] : 'auto';
    if ((options.colorScale ?? (panel.form === 'matrix' ? 'linear' : 'log')) === 'log' && options.colorDomain !== 'auto' && options.colorDomain[0] <= 0) options.colorDomain = 'auto';
  }
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

describe('form option schema compatibility', () => {
  const patches: Partial<PanelOptions>[] = [
    {}, { bins: 9.6, quantiles: 'tails', boxSort: 'n' },
    { colorScale: 'log', colorDomain: [-1, 2], cells: 120 },
    { colorScale: 'sqrt', colorDomain: [0, 20], cells: 30 },
    { xRange: [9, 1], yRange: [0, 0], xScale: 'log', yScale: 'symlog' },
    { k: 99, seed: -1, sampleSize: 50000, showPoints: true, clusterOrder: true, clusterSplit: true },
    { k: Number.NaN, seed: Number.NaN, sampleSize: Number.NaN, bins: Number.NaN },
    { family: 'custom', metrics: [asColumnId('fd_mean'), asColumnId('fd_mean'), asColumnId('missing')], coefficient: 'pearson' },
    { coverageWindow: 'custom', coverageCustom: ['2026-01-01', '2020-01-01'], cumulative: true, share: true, coverageLogY: true },
    { layout: 'stacked100', splitPresentation: 'facets' },
    { colorScale: 'bad', colorDomain: [2], cells: 10, family: 7, metrics: false,
      quantiles: 'bad', xScale: 'bad', yMode: 'bad', boxSort: 'bad', showPoints: 'yes' } as unknown as Partial<PanelOptions>,
  ];
  for (const form of FORM_ORDER) {
    it(form + ' preserves normalization, including options belonging to inactive forms', () => {
      for (const series of [[], [{ kind: 'field' as const, field: asColumnId('manufacturer') }]]) {
        const panel: Panel = { ...defaultDashboard().panels[0], form, series, cursors: [null], options: defaultPanelOptions() };
        for (const patch of patches) {
          expect(normalizedOptions(panel, patch, 'bold')).toEqual(beforeRegistry(panel, patch, 'bold'));
        }
      }
    });
  }
});

describe('flat form option adapters', () => {
  it('retains the complete existing option type at the reducer boundary', () => {
    expectTypeOf<RegistryOptions>().toExtend<PanelOptions>();
    expectTypeOf<PanelOptions>().toExtend<RegistryOptions>();
    const patch = { bins: 80, k: 4 };
    expect(optionPatch(patch)).toBe(patch);
  });
  it('reads only the selected form bag and uses its declared defaults', () => {
    expect(optionValues(histogramOptions, {})).toEqual({ bins: 40 });
    expect(optionValues(histogramOptions, { bins: 80, k: 4 })).toEqual({ bins: 80 });
  });
});
