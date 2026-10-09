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

/** The fixed order shared by form pickers and form availability checks. */
export const FORM_ORDER = [
  'histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table',
  'heatmap', 'scatter', 'hexbin', 'clusters', 'band', 'lines',
  'bars', 'share', 'matrix',
] as const;

export type FormAvailability = {
  form: Form;
  state: 'enabled' | 'disabled' | 'hidden';
  reason?: string;
};

const SECOND_COLUMN_REASON = 'add a second column';

/**
 * Kept in FORM_ORDER so link tokens stay put, offered nowhere. Hexbin binned a
 * point sample on a linear grid; the heatmap counts every scan. Old links
 * fall back to the default form, which for two metrics is the heatmap.
 */
const RETIRED: ReadonlySet<Form> = new Set<Form>(['hexbin']);

/** The one axis-to-form rule used by the reducer, dropdown and dispatcher. */
export function formAvailability(
  x: ColumnRef | readonly MetricId[],
  y: MetricId | null,
): readonly FormAvailability[] {
  const type = axisType(x);
  const enabled =
    type === 'metrics'
      ? new Set<Form>(['matrix'])
      : type === 'categorical'
        ? new Set<Form>(['bars', 'share'])
        : y === null
          // Counts over time can also be a band: the spread of daily counts in each bin.
          ? new Set<Form>([...FORM_ORDER.slice(0, 7), ...(type === 'time' ? ['band' as const] : [])])
          : new Set<Form>(FORM_ORDER.slice(7, 13));
  const disabled =
    (type === 'numeric' || type === 'time') && y === null
      ? new Set<Form>(FORM_ORDER.slice(7, 13).filter(form => !enabled.has(form)))
      : new Set<Form>();

  return FORM_ORDER.map((form): FormAvailability =>
    RETIRED.has(form) ? { form, state: 'hidden' }
    : enabled.has(form)
      ? { form, state: 'enabled' }
      : disabled.has(form)
        ? { form, state: 'disabled', reason: SECOND_COLUMN_REASON }
        : { form, state: 'hidden' },
  );
}

export function formsFor(x: ColumnRef | readonly MetricId[], y: MetricId | null): readonly Form[] {
  return formAvailability(x, y)
    .filter(({ state }) => state === 'enabled')
    .map(({ form }) => form);
}

/** A correlation's quantity is its metric set; x remains its primary metric. */
export function panelForms(panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'>): readonly Form[] {
  return panelFormAvailability(panel)
    .filter(({ state }) => state === 'enabled')
    .map(({ form }) => form);
}

/** Resolves a panel's matrix metric set before applying the shared form rule. */
export function panelFormAvailability(
  panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'>,
): readonly FormAvailability[] {
  return formAvailability(
    panel.form === 'matrix' ? panel.options.metrics ?? [panel.x as MetricId] : panel.x,
    panel.y,
  );
}

export function defaultForm(x: Panel['x'], y: Panel['y']): Form {
  return axisType(x) === 'time' && y !== null ? 'band' : formsFor(x, y)[0] ?? 'histogram';
}

export function validForm(panel: Panel): Panel {
  const forms = panelForms(panel);
  return forms.includes(panel.form)
    ? panel
    : { ...panel, form: defaultForm(panel.x, panel.y) };
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
  band: { label: 'Band', icon: 'chart-area', hint: 'Median with a quantile band per x bin' },
  lines: { label: 'Lines', icon: 'chart-line', hint: 'Three quantile lines per x bin' },
  heatmap: { label: 'Heatmap', icon: 'grid-2x2', hint: 'Density across paired values' },
  share: { label: 'Share', icon: 'chart-column', hint: 'Proportion in each category' },
  matrix: { label: 'Matrix', icon: 'grid-2x2', hint: 'Relationships within a metric set' },
  line: { label: 'Line', icon: 'chart-line', hint: 'Counts per bin as a line' },
  scatter: { label: 'Scatter', icon: 'chart-scatter', hint: 'A sample of paired values' },
  hexbin: { label: 'Hexbin', icon: 'hexagon', hint: 'Sample counts in hexagonal cells' },
  clusters: { label: 'Clusters', icon: 'shapes', hint: 'Exploratory groups in a sample' },
  area: { label: 'Area', icon: 'chart-area', hint: 'Trend; stacked share with series' },
};
