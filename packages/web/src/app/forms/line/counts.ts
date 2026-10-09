import type { TopLevelSpec } from 'vega-lite';
import type { MetricAxis } from '../histogram/histogram';
import type { CohortSeries } from '../shared/comparison';
import { continuousX } from '../shared/continuous-axis';
import { baseConfig, FILLS_CONTAINER, LIGHT_THEME, VL_SCHEMA } from '../shared/palette';

/** Counts per bin; the geometry and scale are independent of the source column. */
export function countsSpec(axis: MetricAxis, form: 'line' | 'area', series: readonly CohortSeries[], layout = 'overlaid'): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  const stackedShare = form === 'area' && series.length > 1 || layout === 'stacked100';
  const share = stackedShare || axis.yMode === 'share';
  const x = continuousX(axis, 'value');
  return {
    $schema: VL_SCHEMA, ...baseConfig(theme), ...FILLS_CONTAINER, data: { name: 'counts' },
    mark: form === 'line' ? { type: 'line', strokeWidth: 2, point: true } : { type: 'area', interpolate: 'linear', opacity: 0.6 },
    encoding: {
      x,
      y: { field: share && !stackedShare ? 'share' : 'count', type: 'quantitative',
        title: share ? `Share of ${axis.countTitle.toLowerCase()}` : axis.countTitle,
        stack: form === 'line' ? null : stackedShare ? 'normalize' : layout === 'stacked' ? 'zero' : null,
        axis: share ? { format: '.0%' } : {}, scale: share ? { domain: [0, 1] } : axis.yMode === 'logCount' ? { type: 'log', clamp: true } : {} },
      color: { field: 'cohort', type: 'nominal', scale: { domain: series.map(s => s.id), range: series.map(s => s.color) }, legend: null },
      // A line uses `order` to sort its points. On an area it groups instead,
      // making every bin its own one-point area: an empty chart.
      ...(form === 'line' ? { order: { field: 'value', type: 'quantitative' } } : {}),
      tooltip: [{ field: 'label', title: 'Series' }, { ...continuousX(axis, 'lo'), title: axis.label },
        { field: 'count', type: 'quantitative', title: axis.countTitle }],
    },
  } as unknown as TopLevelSpec;
}
