import { getAuthoredCatalog } from '@mriqc/shared';
import type { ColumnRef, Form, MetricId, Panel } from './state';

export type AxisType = 'numeric' | 'time' | 'categorical' | 'metrics';

/** Axis types determine the available forms. There is no panel-kind taxonomy. */
export function axisType(x: ColumnRef | readonly MetricId[]): AxisType {
  if (Array.isArray(x)) return 'metrics';
  if (x === 'created_at') return 'time';
  return getAuthoredCatalog().fields.some(field => field.id === x && field.kind === 'categorical')
    ? 'categorical' : 'numeric';
}

const NUMERIC_FORMS = ['histogram', 'density', 'ecdf', 'box', 'table'] as const;
const TIME_FORMS = ['bars', 'line', 'area'] as const;
const TIME_METRIC_FORMS = ['band', 'lines'] as const;
const PAIR_FORMS = ['heatmap', 'scatter', 'hexbin', 'clusters'] as const;
const CATEGORY_FORMS = ['bars', 'share'] as const;

/** The one axis-to-form rule used by the reducer, dropdown and dispatcher. */
export function formsFor(x: ColumnRef | readonly MetricId[], y: MetricId | null) {
  switch (axisType(x)) {
    case 'metrics': return ['matrix'] as const;
    case 'time': return y === null ? TIME_FORMS : TIME_METRIC_FORMS;
    case 'categorical': return CATEGORY_FORMS;
    case 'numeric': return y === null ? NUMERIC_FORMS : PAIR_FORMS;
  }
}

/** A correlation's quantity is its metric set; x remains its primary metric. */
export function panelForms(panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'>): readonly Form[] {
  return formsFor(panel.form === 'matrix' ? panel.options.metrics ?? [panel.x as MetricId] : panel.x, panel.y);
}

export function validForm(panel: Panel): Panel {
  const forms = panelForms(panel);
  return forms.includes(panel.form) ? panel : { ...panel, form: forms[0] };
}

export function brushable(panel: Panel): boolean {
  return axisType(panel.x) === 'numeric' && ['histogram', 'density', 'ecdf', 'heatmap', 'scatter', 'hexbin'].includes(panel.form);
}

export interface FormInfo { label: string; icon: string; hint: string }
export const FORM_INFO: Record<Form, FormInfo> = {
  histogram: { label: 'Histogram', icon: 'chart-column', hint: 'Counts in equal-width bins' },
  density: { label: 'Density', icon: 'chart-area', hint: 'Smoothed distribution of values' },
  ecdf: { label: 'ECDF', icon: 'chart-line', hint: 'Share at or below each value' },
  box: { label: 'Box', icon: 'chart-candlestick', hint: 'Median and spread' },
  table: { label: 'Table', icon: 'table-2', hint: 'Individual records behind the chart' },
  bars: { label: 'Bars', icon: 'chart-column', hint: 'Counts per bucket; stacked with series' },
  band: { label: 'Band', icon: 'chart-area', hint: 'Median and middle half through time' },
  lines: { label: 'Lines', icon: 'chart-line', hint: '5th, 50th and 95th percentiles through time' },
  heatmap: { label: 'Heatmap', icon: 'grid-2x2', hint: 'Density across two metrics' },
  share: { label: 'Share', icon: 'chart-column', hint: 'Proportion in each category' },
  matrix: { label: 'Matrix', icon: 'grid-2x2', hint: 'Relationships within a metric set' },
  line: { label: 'Line', icon: 'chart-line', hint: 'Upload counts through time' },
  scatter: { label: 'Scatter', icon: 'chart-scatter', hint: 'A sample of paired values' },
  hexbin: { label: 'Hexbin', icon: 'hexagon', hint: 'Sample counts in hexagonal cells' },
  clusters: { label: 'Clusters', icon: 'shapes', hint: 'Exploratory groups in a sample' },
  area: { label: 'Area', icon: 'chart-area', hint: 'Trend; stacked share with series' },
};
