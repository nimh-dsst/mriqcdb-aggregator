import { describe, expect, it } from 'vitest';
import { asColumnId } from '@mriqc/shared';
import type { Form, MetricId } from './state';
import { FORM_ORDER, formAvailability, formsFor } from './panel-shapes';

const pairForms = ['heatmap', 'scatter', 'hexbin', 'clusters'] as const satisfies readonly Form[];
const numericForms = ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table', 'band'] as const satisfies readonly Form[];
const fdMean = asColumnId('fd_mean');
const tsnr = asColumnId('tsnr');
const manufacturer = asColumnId('manufacturer');
const metricSet: readonly MetricId[] = [fdMean, tsnr];

function expected(enabled: readonly Form[], disabled: readonly Form[] = []) {
  return FORM_ORDER.map(form =>
    enabled.includes(form)
      ? { form, state: 'enabled' as const }
      : disabled.includes(form)
        ? { form, state: 'disabled' as const, reason: 'add a second column' }
        : { form, state: 'hidden' as const },
  );
}

function assertAvailability(
  x: Parameters<typeof formAvailability>[0],
  y: Parameters<typeof formAvailability>[1],
  enabled: readonly Form[],
  disabled: readonly Form[] = [],
) {
  expect(formAvailability(x, y)).toEqual(expected(enabled, disabled));
  expect(formsFor(x, y)).toEqual(FORM_ORDER.filter(form => enabled.includes(form)));
}

describe('formAvailability', () => {
  it('keeps the fixed fifteen-form picker order', () => {
    expect(FORM_ORDER).toEqual([
      'histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table',
      'heatmap', 'scatter', 'hexbin', 'clusters', 'band',
      'bars', 'share', 'matrix',
    ]);
  });

  it('enables one-axis numeric forms and explains paired forms', () => {
    assertAvailability(fdMean, 'count', numericForms, pairForms);
  });

  it('enables numeric paired forms when a second metric is selected', () => {
    assertAvailability(fdMean, tsnr, [...numericForms, ...pairForms]);
  });

  it('applies the same one-axis availability to time fields', () => {
    assertAvailability('created_at', 'count', numericForms, pairForms);
  });

  it('enables time paired forms when a second metric is selected', () => {
    assertAvailability('created_at', tsnr, [...numericForms, ...pairForms]);
  });

  it('only exposes categorical bindings without a second metric', () => {
    assertAvailability(manufacturer, 'count', ['box', 'table', 'bars', 'share']);
  });

  it('keeps categorical bindings when a second metric is selected', () => {
    assertAvailability(manufacturer, tsnr, ['box', 'table', 'bars', 'share']);
  });

  it('only exposes Matrix for metric-set quantities without a second metric', () => {
    assertAvailability(metricSet, 'count', ['matrix']);
  });

  it('only exposes Matrix for metric-set quantities with a second metric', () => {
    assertAvailability(metricSet, tsnr, ['matrix']);
  });
});
