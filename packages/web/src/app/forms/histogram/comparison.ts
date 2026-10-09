import type { TopLevelSpec } from 'vega-lite';

import { baseConfig, LIGHT_THEME, FILLS_CONTAINER, VL_SCHEMA, axisTitle, brushParam, valueScale } from '../shared/palette';
import type { MetricAxis } from '../histogram/histogram';


import { COHORTS_DATA, type CohortSeries, cohortScale, shareTooltip, OUTLINE, FILL_OPACITY, shareAxisTitle } from '../shared/comparison-primitives';

export function overlaidHistogramSpec(
  axis: MetricAxis,
  cohorts: readonly CohortSeries[],
  brush: readonly [number, number] | null = null,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    ...FILLS_CONTAINER,
    data: { name: COHORTS_DATA },
    params: [brushParam(brush, theme)],
    mark: {
      type: 'area',
      interpolate: 'step-after',
      fillOpacity: FILL_OPACITY,
      line: { ...OUTLINE },
    },
    encoding: {
      x: {
        field: 'lo',
        type: 'quantitative',
        title: axisTitle(axis.label, axis.unit),
        scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
      },
      y: {
        field: 'share',
        type: 'quantitative',
        stack: null,
        title: axis.yMode && axis.yMode !== 'share' ? axis.countTitle : shareAxisTitle(axis.countTitle),
        axis: axis.yMode && axis.yMode !== 'share' ? {} : { format: '.0%' },
        ...(axis.yMode && axis.yMode !== 'share' ? { field: 'count' } : {}),
        ...(axis.yMode === 'logCount' ? { scale: { type: 'log', clamp: true } } : {}),
      },
      color: cohortScale(cohorts, true, theme),
      tooltip: shareTooltip(axis, true),
    },
  } as unknown as TopLevelSpec;
}

/**
 * The same silhouette, smoothed: one Gaussian-kernel density per cohort over the
 * shared grid, as a translucent area with a 2px outline.
 *
 * The default comparison chart. A step histogram answers "how was this binned";
 * a density answers "what shape is this", which is the question a reader
 * overlaying two cohorts is asking. `interpolate: 'monotone'` rather than a
 * straight line between the 200 points, so the curve does not develop corners
 * the smoothing was meant to remove; monotone and not basis, because a spline
 * that overshoots would draw negative share.
 */
