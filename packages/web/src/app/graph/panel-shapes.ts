import type { ColumnRef, Form, MetricId, Panel } from './state';

import { axisType } from '../forms/availability';
import { FORM_ORDER, formDef, formAvailability, type FormAvailability } from '../forms/registry';
export { axisType, type AxisType } from '../forms/availability';
export { FORM_ORDER, formAvailability, type FormAvailability } from '../forms/registry';

export function formsFor(x: ColumnRef | readonly MetricId[], y: MetricId | null): readonly Form[] {
  return formAvailability(x, y)
    .filter(({ state }) => state === 'enabled')
    .map(({ form }) => form);
}

/** A correlation's quantity is its metric set; x remains its primary metric. */
export function panelForms(panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'> & Partial<Pick<Panel, 'series'>>): readonly Form[] {
  return panelFormAvailability(panel)
    .filter(({ state }) => state === 'enabled')
    .map(({ form }) => form);
}

/** Resolves a panel's matrix metric set before applying the shared form rule. */
export function panelFormAvailability(
  panel: Pick<Panel, 'x' | 'y' | 'form' | 'options'> & Partial<Pick<Panel, 'series'>>,
): readonly FormAvailability[] {
  return formAvailability(
    FORM_ORDER.includes(panel.form) && formDef(panel.form).metricSet ? panel.options.metrics ?? [panel.x as MetricId] : panel.x,
    panel.y,
    panel.series,
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
  return axisType(panel.x) === 'numeric' && FORM_ORDER.includes(panel.form) && formDef(panel.form).brushable;
}

export interface FormInfo { label: string; icon: string; hint: string }
export const FORM_INFO = Object.fromEntries(FORM_ORDER.map(id => {
  const { label, icon, hint } = formDef(id);
  return [id, { label, icon, hint }];
})) as Record<Form, FormInfo>;
