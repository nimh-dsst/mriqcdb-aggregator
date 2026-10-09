import { asColumnId, canonicalViewFor, type ClipMode } from '@mriqc/shared';
import type { PanelOptions, UrlState } from '../../graph/state';

export function defaultPanelOptions(clip: ClipMode = 'p01p99'): PanelOptions {
  return {
    bins: 40,
    cells: 60,
    colorDomain: 'auto',
    clip,
    xScale: 'linear', xRange: 'auto', yScale: 'linear', yRange: 'auto',
    yMode: 'count', layout: 'overlaid',
    quantiles: 'quartiles',
    useSelection: true,
    granularity: 'month',
    splitPresentation: 'overlay',
    cumulative: false,
    share: false,
    coverageWindow: 'all',
    coverageLogY: false,
    coverageCustom: null,
    boxSort: 'median',
  };
}

export function defaultDashboard(): UrlState {
  const options = defaultPanelOptions();
  const metrics: readonly string[] = ['fd_mean', 'tsnr', 'dvars_std', 'snr'];
  const panels = metrics.map((metric, i) => ({
    id: `p${i + 1}`,
    x: asColumnId(metric),
    y: null,
    form: 'histogram' as const,
    series: [],
    options: { ...options },
  }));
  return {
    global: { modality: 'bold', view: canonicalViewFor('bold'), filters: [] },
    // No cohorts: `current` and `all` are derived and always there, and a
    // default dashboard is metric lookup, which is what the comparison panel
    // exists to be an answer to rather than a replacement for.
    cohorts: [],
    panels: [
      ...panels,
      {
        id: `p${metrics.length + 1}`,
        x: 'created_at',
        y: null,
        form: 'histogram' as const,
        series: [],
        options: { ...options },
      },
    ],
    selections: [],
  };
}

