import { describe, expect, it } from 'vitest';
import { asColumnId } from '@mriqc/shared';
import type { Form, MetricId } from '../../graph/state';
import { FORM_ORDER, formAvailability, formsFor } from '../../graph/panel-shapes';

const pairForms = ['heatmap', 'scatter', 'clusters', 'band', 'lines'] as const satisfies readonly Form[];
const numericForms = ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table'] as const satisfies readonly Form[];
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
  y: MetricId | null,
  enabled: readonly Form[],
  disabled: readonly Form[] = [],
) {
  expect(formAvailability(x, y)).toEqual(expected(enabled, disabled));
  expect(formsFor(x, y)).toEqual(enabled);
}

describe('formAvailability', () => {
  it('keeps the fixed sixteen-form picker order', () => {
    expect(FORM_ORDER).toEqual([
      'histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table',
      'heatmap', 'scatter', 'hexbin', 'clusters', 'band', 'lines',
      'bars', 'share', 'matrix',
    ]);
  });

  it('enables one-axis numeric forms and explains paired forms', () => {
    assertAvailability(fdMean, null, numericForms, pairForms);
  });

  it('enables numeric paired forms when a second metric is selected', () => {
    assertAvailability(fdMean, tsnr, pairForms);
  });

  it('applies the same one-axis availability to time fields', () => {
    // Plus band: counts over time can show the spread of daily counts per bin.
    assertAvailability('created_at', null, [...numericForms, 'band'], pairForms.filter(form => form !== 'band'));
  });

  it('enables time paired forms when a second metric is selected', () => {
    assertAvailability('created_at', tsnr, pairForms);
  });

  it('only exposes categorical bindings without a second metric', () => {
    assertAvailability(manufacturer, null, ['bars', 'share']);
  });

  it('keeps categorical bindings when a second metric is selected', () => {
    assertAvailability(manufacturer, tsnr, ['bars', 'share']);
  });

  it('only exposes Matrix for metric-set quantities without a second metric', () => {
    assertAvailability(metricSet, null, ['matrix']);
  });

  it('only exposes Matrix for metric-set quantities with a second metric', () => {
    assertAvailability(metricSet, tsnr, ['matrix']);
  });
});
