import { getAuthoredCatalog } from '@mriqc/shared';

import type {
  Aggregate,
  ColumnRef,
  Form,
  MetricId,
  Panel,
  YQuantity,
} from './state';
import { isColumnY } from './state';

export type AxisType = 'metrics' | 'time' | 'categorical' | 'numeric';

export interface FormAvailability {
  form: Form;
  state: 'enabled' | 'disabled' | 'hidden';
  reason?: string;
}

interface FormInfo {
  label: string;
  icon: string;
  hint: string;
}

export const FORM_ORDER = [
  'histogram',
  'line',
  'area',
  'density',
  'ecdf',
  'box',
  'table',
  'heatmap',
  'scatter',
  'hexbin',
  'clusters',
  'band',
  'bars',
  'share',
  'matrix',
] as const;

const CONTINUOUS_FORMS = [
  'histogram',
  'line',
  'area',
  'density',
  'ecdf',
  'box',
  'band',
  'table',
] as const;

const TWO_DIMENSIONAL_FORMS = [
  'heatmap',
  'scatter',
  'hexbin',
  'clusters',
] as const;

const CATEGORICAL_FORMS = ['bars', 'share', 'box', 'table'] as const;

const BINNED_FORMS = ['histogram', 'line', 'area', 'density', 'ecdf', 'bars', 'share'] as const;

const BRUSHABLE_FORMS: readonly Form[] = [
  'histogram',
  'density',
  'ecdf',
  'heatmap',
  'scatter',
  'hexbin',
];

const UNSUPPORTED_BINNED_AGGREGATES = new Set<Aggregate>(['sum', 'min', 'max']);

export function axisType(x: ColumnRef | readonly MetricId[]): AxisType {
  if (Array.isArray(x)) {
    return 'metrics';
  }
  if (x === 'created_at') {
    return 'time';
  }

  const authored = getAuthoredCatalog();
  return authored.fields.some((field) => field.id === x && field.kind === 'categorical')
    ? 'categorical'
    : 'numeric';
}

export function formAvailability(
  x: ColumnRef | readonly MetricId[],
  y: YQuantity,
  seriesCount = 1,
  aggregate?: Aggregate,
): readonly FormAvailability[] {
  const type = axisType(x);
  const enabled = new Set<Form>();
  const disabled = new Map<Form, string>();

  if (type === 'metrics') {
    enabled.add('matrix');
  } else if (type === 'categorical') {
    for (const form of CATEGORICAL_FORMS) {
      enabled.add(form);
    }
    if (isColumnY(y) && (aggregate === 'sum' || (y === 'created_at' && (aggregate === 'min' || aggregate === 'max')))) {
      for (const form of ['bars', 'share'] as const) {
        enabled.delete(form);
        disabled.set(form, 'not available for this aggregate');
      }
    }
  } else {
    for (const form of CONTINUOUS_FORMS) {
      enabled.add(form);
    }

    if (isColumnY(y)) {
      for (const form of TWO_DIMENSIONAL_FORMS) {
        enabled.add(form);
      }
    } else {
      for (const form of TWO_DIMENSIONAL_FORMS) {
        disabled.set(form, 'add a second column');
      }
    }
    if (y === 'count' && seriesCount < 1) {
      enabled.delete('band');
      disabled.set('band', 'add a series');
    }

    if (isColumnY(y) && aggregate && UNSUPPORTED_BINNED_AGGREGATES.has(aggregate)) {
      for (const form of BINNED_FORMS) {
        if (enabled.delete(form)) {
          disabled.set(form, 'not available for this aggregate');
        }
      }
    }
  }

  return FORM_ORDER.map((form) => {
    const reason = disabled.get(form);
    if (reason) {
      return { form, state: 'disabled', reason };
    }
    if (enabled.has(form)) {
      return { form, state: 'enabled' };
    }
    return { form, state: 'hidden' };
  });
}

export function formsFor(
  x: ColumnRef | readonly MetricId[],
  y: YQuantity,
  seriesCount = 1,
  aggregate?: Aggregate,
): readonly Form[] {
  return formAvailability(x, y, seriesCount, aggregate)
    .filter((availability) => availability.state === 'enabled')
    .map((availability) => availability.form);
}

export function panelFormAvailability(
  panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'> & Partial<Pick<Panel, 'aggregate'>>,
  seriesCount = 1,
  aggregate?: Aggregate,
): readonly FormAvailability[] {
  const x =
    panel.form === 'matrix'
      ? panel.options.metrics ?? [panel.x as MetricId]
      : panel.x;
  return formAvailability(x, panel.y, seriesCount, aggregate ?? panel.aggregate);
}

export function panelForms(
  panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'> & Partial<Pick<Panel, 'aggregate'>>,
  seriesCount = 1,
  aggregate?: Aggregate,
): readonly Form[] {
  return panelFormAvailability(panel, seriesCount, aggregate)
    .filter((availability) => availability.state === 'enabled')
    .map((availability) => availability.form);
}

export function defaultForm(x: Panel['x'], y: Panel['y']): Form {
  const type = axisType(x);
  if (type === 'metrics') {
    return 'matrix';
  }
  if (type === 'categorical') {
    return 'bars';
  }
  if (isColumnY(y)) {
    return type === 'time' ? 'band' : 'heatmap';
  }
  return 'histogram';
}

export function validForm(panel: Panel, seriesCount = 1): Panel {
  return panelForms(panel, seriesCount, panel.aggregate).includes(panel.form)
    ? panel
    : { ...panel, form: defaultForm(panel.x, panel.y) };
}

export const FORM_INFO: Readonly<Record<Form, FormInfo>> = {
  histogram: { label: 'Histogram', icon: 'chart-column', hint: 'Distribution by x bin' },
  line: { label: 'Line', icon: 'chart-line', hint: 'Value by x bin' },
  area: { label: 'Area', icon: 'chart-area', hint: 'Filled value by x bin' },
  density: { label: 'Density', icon: 'chart-area', hint: 'Smoothed distribution' },
  ecdf: { label: 'ECDF', icon: 'chart-line', hint: 'Cumulative distribution' },
  box: { label: 'Box', icon: 'chart-candlestick', hint: 'Distribution summary' },
  table: { label: 'Table', icon: 'table-2', hint: 'Individual records behind the chart' },
  heatmap: { label: 'Heatmap', icon: 'grid-2x2', hint: 'Two-dimensional density' },
  scatter: { label: 'Scatter', icon: 'chart-scatter', hint: 'One point per observation' },
  hexbin: { label: 'Hexbin', icon: 'hexagon', hint: 'Two-dimensional bins' },
  clusters: { label: 'Clusters', icon: 'shapes', hint: 'Clustered observations' },
  band: { label: 'Band', icon: 'chart-area', hint: 'Quantiles of y per x bin' },
  bars: { label: 'Bars', icon: 'chart-column', hint: 'Category counts or shares' },
  share: { label: 'Share', icon: 'chart-column', hint: 'Category share' },
  matrix: { label: 'Matrix', icon: 'grid-2x2', hint: 'Metric relationships' },
};

export function brushable(panel: Panel): boolean {
  return (
    axisType(panel.x) === 'numeric' &&
    BRUSHABLE_FORMS.includes(panel.form)
  );
}
