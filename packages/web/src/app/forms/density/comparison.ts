import type { TopLevelSpec } from 'vega-lite';

import { baseConfig, LIGHT_THEME, FILLS_CONTAINER, VL_SCHEMA, axisTitle, brushParam, valueScale } from '../shared/palette';
import type { MetricAxis } from '../histogram/histogram';


import { COHORTS_DATA, type CohortSeries, cohortScale, OUTLINE, FILL_OPACITY, densityAxisTitle } from '../shared/comparison-primitives';

export function overlaidDensitySpec(
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
      interpolate: 'monotone',
      fillOpacity: FILL_OPACITY,
      line: { ...OUTLINE },
    },
    encoding: {
      x: {
        field: 'value',
        type: 'quantitative',
        title: axisTitle(axis.label, axis.unit),
        scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
      },
      y: {
        field: 'share',
        type: 'quantitative',
        stack: null,
        title: axis.yMode && axis.yMode !== 'share' ? `${axis.countTitle} (smoothed)` : densityAxisTitle(axis.countTitle),
        axis: axis.yMode && axis.yMode !== 'share' ? {} : { format: '.1%' },
        ...(axis.yMode && axis.yMode !== 'share' ? { field: 'count' } : {}),
        ...(axis.yMode === 'logCount' ? { scale: { type: 'log', clamp: true } } : {}),
      },
      color: cohortScale(cohorts, true, theme),
      tooltip: [
        { field: 'label', type: 'nominal', title: 'Cohort' },
        { field: 'value', type: 'quantitative', title: axis.label },
        { field: 'share', type: 'quantitative', title: 'Smoothed share', format: '.2%' },
      ],
    },
  } as unknown as TopLevelSpec;
}

/** 2px, round join and cap, step-after. The same line `ecdf.ts` draws. */
