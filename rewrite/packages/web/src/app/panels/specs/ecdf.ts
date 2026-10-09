/**
 * Empirical CDFs, drawn as a step line over `{ value, p }` rows. The rows come
 * from the quantiles the `distribution` procedure returns plus the cumulative
 * histogram, so no raw values ever cross the wire.
 */

import type { TopLevelSpec } from 'vega-lite';
import {
  baseConfig,
  LIGHT_THEME,
  type ChartTheme,
  OTHER_COLOR,
  FILLS_CONTAINER,
  VL_SCHEMA,
  axisTitle,
  brushParam,
  valueScale,
  groupRange,
} from './palette';
import { GROUPS_DATA, POPULATION_DATA, type MetricAxis } from './histogram';

function valueX(axis: MetricAxis) {
  return {
    field: 'value',
    type: 'quantitative',
    title: axisTitle(axis.label, axis.unit),
    scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
  };
}

const PROPORTION_Y = {
  field: 'p',
  type: 'quantitative',
  title: 'Cumulative share',
  axis: { format: '.0%' },
  scale: { domain: [0, 1] },
} as const;

/** 2px, round join and cap, per the mark specs. */
const STEP_LINE = {
  type: 'line',
  interpolate: 'step-after',
  strokeWidth: 2,
  strokeJoin: 'round',
  strokeCap: 'round',
} as const;

/** One ECDF with an x-interval brush, seeded from this panel's own selection. */
export function ecdfSpec(
  axis: MetricAxis,
  brush: readonly [number, number] | null = null,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    ...FILLS_CONTAINER,
    data: { name: POPULATION_DATA },
    params: [brushParam(brush, theme)],
    mark: { ...STEP_LINE, color: theme.populationColor },
    encoding: { x: valueX(axis), y: PROPORTION_Y },
  } as unknown as TopLevelSpec;
}

/**
 * One ECDF per group value, over `{ group, value, p }` rows. The facet header
 * names each group, so there is no legend.
 */
export function facetedEcdfSpec(
  axis: MetricAxis,
  groupLabel: string,
  groups: readonly string[] = [],
  ordered = false,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  const groupScale =
    groups.length === 0
      ? { range: [...theme.categories, OTHER_COLOR] }
      : { domain: groups, range: groupRange(groups, ordered, theme) };
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    data: { name: GROUPS_DATA },
    facet: { field: 'facet', type: 'nominal', title: groupLabel, sort: null },
    columns: 3,
    spec: {
      width: 190,
      height: 110,
      mark: { ...STEP_LINE },
      encoding: {
        x: valueX(axis),
        y: PROPORTION_Y,
        color: {
          field: 'group',
          type: 'nominal',
          scale: groupScale,
          legend: null,
        },
      },
    },
  } as unknown as TopLevelSpec;
}
