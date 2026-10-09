import type { TopLevelSpec } from 'vega-lite';

import { baseConfig, LIGHT_THEME, FILLS_CONTAINER, VL_SCHEMA, axisTitle, brushParam, valueScale } from '../shared/palette';
import type { MetricAxis } from '../histogram/histogram';


import { COHORTS_DATA, type CohortSeries, cohortScale, OUTLINE } from '../shared/comparison-primitives';

const STEP_LINE = {
  type: 'line',
  interpolate: 'step-after',
  ...OUTLINE,
} as const;

/**
 * One step line per cohort on one pair of axes.
 *
 * Drawn from each cohort's *own* distribution rather than the shared-range
 * histograms, so the panel has its ECDFs and its statistics the moment step one
 * lands and does not wait for the shared range to be known
 * (`comparison-design.md`, "Query model").
 */
export function overlaidEcdfSpec(
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
    mark: { ...STEP_LINE },
    encoding: {
      x: {
        field: 'value',
        type: 'quantitative',
        title: axisTitle(axis.label, axis.unit),
        scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
      },
      y: {
        field: 'p',
        type: 'quantitative',
        title: 'Cumulative share',
        axis: { format: '.0%' },
        scale: { domain: [0, 1] },
      },
      color: cohortScale(cohorts, true, theme),
      tooltip: [
        { field: 'label', type: 'nominal', title: 'Cohort' },
        { field: 'value', type: 'quantitative', title: axis.label },
        { field: 'p', type: 'quantitative', title: 'At or below', format: '.1%' },
      ],
    },
  } as unknown as TopLevelSpec;
}

/**
 * One box row per cohort: the p05..p95 whisker, the interquartile box in the
 * cohort's hue, and the median tick.
 *
 * The same three marks `boxSpec` draws, over a `cohort` id instead of a `group`
 * value and with the cohort colour scale -- and with no legend, because the y
 * axis names every cohort, which is a direct label and the stronger channel. The
 * axis is labelled from `label`, so two cohorts sharing a name still occupy two
 * rows, keyed by id.
 */
