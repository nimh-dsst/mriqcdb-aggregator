/**
 * Bar charts over pre-binned rows.
 *
 * Every spec here names its data (`data: { name }`) instead of inlining
 * values, which is what lets the Vega directive swap datasets with
 * `view.data(name, rows)` instead of re-embedding. Rows are
 * `{ lo, hi, count }`, exactly what `distribution`'s histogram carries.
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
} from '../shared/palette';

/** What every distribution-shaped spec needs to know about its metric. */
export interface MetricAxis {
  theme?: ChartTheme;
  label: string;
  unit?: string;
  logScale: boolean;
  xScale?: 'linear' | 'log' | 'symlog' | 'time';
  granularity?: import('@mriqc/shared').Granularity;
  xRange?: 'auto' | readonly [number, number];
  constant?: number;
  yMode?: 'count' | 'share' | 'logCount';
  /**
   * What the count axis is counting, in the view's own noun: "Scans" or
   * "Uploads". Never "Records" -- that was true of both views and so said
   * nothing about either.
   */
  countTitle: string;
}

/**
 * Dataset names the panel projection fills in.
 *
 * A comparison panel has its own, `COHORTS_DATA` in `comparison.ts`: its rows
 * carry a `cohort` column and one dataset serves any number of cohorts, where
 * a name per series would need a new name every time a cohort was added.
 */
export const POPULATION_DATA = 'population';
export const GROUPS_DATA = 'groups';

function countAxis(axis: MetricAxis) {
  return { field: axis.yMode === 'share' ? 'share' : 'count', type: 'quantitative',
    title: axis.yMode === 'share' ? `Share of ${axis.countTitle.toLowerCase()}` : axis.countTitle,
    ...(axis.yMode === 'share' ? { axis: { format: '.0%' } } : {}),
    ...(axis.yMode === 'logCount' ? { scale: { type: 'log', clamp: true } } : {}) } as const;
}

/**
 * Thin bars with a 2px surface gap, which `config.bar.binSpacing` supplies.
 *
 * Square at both ends, not rounded at the data end as the mark specs prefer:
 * `cornerRadiusEnd` sends Vega-Lite 6.4.3 down its rounded-stack-end path,
 * which rewrites the x encoders to read `lo_end` -- a field pre-binned rows do
 * not have, because their end is `hi` through `x2` -- and every bar comes out
 * with a NaN width and draws nothing. Verified against 6.4.3: identical spec,
 * `cornerRadiusEnd` the only difference, 42 rect items either way, x undefined
 * with it and 1.5..9.5 without.
 */
const BAR = { type: 'bar' } as const;

function binnedX(axis: MetricAxis) {
  return {
    field: 'lo',
    type: 'quantitative',
    bin: { binned: true },
    title: axisTitle(axis.label, axis.unit),
    scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
  };
}

/**
 * A single-series histogram with an x-interval brush, seeded with `brush` when
 * this panel is the one the current selection came from.
 */
export function histogramSpec(
  axis: MetricAxis,
  brush: readonly [number, number] | null = null,
  bins = 0,
  separateSpike = false,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  if (separateSpike) {
    const x = binnedX(axis);
    const gap = bins > 100 ? 0 : 2;
    return {
      $schema: VL_SCHEMA,
      ...baseConfig(theme),
      ...FILLS_CONTAINER,
      data: { name: POPULATION_DATA },
      params: [brushParam(brush, theme)],
      layer: [
        {
          transform: [{ filter: '!datum.spike' }],
          mark: { ...BAR, color: theme.populationColor, binSpacing: gap },
          encoding: {
            x,
            x2: { field: 'hi' },
            y: { field: 'plotCount', type: 'quantitative', title: axis.countTitle },
          },
        },
        {
          transform: [{ filter: 'datum.spike' }],
          mark: {
            ...BAR,
            color: theme.populationColor,
            stroke: theme.medianColor,
            strokeWidth: 1,
            binSpacing: gap,
          },
          encoding: {
            x,
            x2: { field: 'hi' },
            y: { field: 'plotCount', type: 'quantitative', title: axis.countTitle },
            tooltip: [
              { field: 'spikeLabel', type: 'nominal', title: 'Exact-value spike' },
              { field: 'count', type: 'quantitative', title: axis.countTitle, format: ',' },
            ],
          },
        },
        {
          transform: [{ filter: 'datum.spike' }],
          mark: { type: 'text', align: 'left', baseline: 'bottom', dx: 2, dy: -3, fontSize: 12 },
          encoding: {
            x: { field: 'lo', type: 'quantitative', scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant) },
            y: { field: 'plotCount', type: 'quantitative' },
            text: { field: 'spikeLabel', type: 'nominal' },
          },
        },
      ],
    } as unknown as TopLevelSpec;
  }
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    ...FILLS_CONTAINER,
    data: { name: POPULATION_DATA },
    params: [brushParam(brush, theme)],
    // At very fine resolutions a visible inter-bar gap becomes a high contrast
    // stripe field. Zero gap lets the reader see one distribution silhouette.
    mark: { ...BAR, color: theme.populationColor, binSpacing: bins > 100 ? 0 : 2 },
    encoding: {
      x: binnedX(axis),
      x2: { field: 'hi' },
      y: countAxis(axis),
    },
  } as unknown as TopLevelSpec;
}

/**
 * One cohort's smoothed share, as a translucent area with a 2px outline.
 *
 * The single-series twin of `overlaidDensitySpec`: `--series-1` rather than a
 * cohort hue, and no legend, because one series is already named by the card
 * header. The y axis says "(smoothed)" because the curve is an estimate -- a
 * kernel over a 200-bin histogram -- and a share axis that did not say so would
 * read as a measurement.
 */
export function densitySpec(
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
    mark: {
      type: 'area',
      interpolate: 'monotone',
      color: theme.populationColor,
      fillOpacity: 0.25,
      line: { strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round' },
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
        title: `Share of ${axis.countTitle.toLowerCase()} (smoothed)`,
        axis: { format: '.0%' },
        ...(axis.yMode && axis.yMode !== 'share' ? { field: 'count', title: `${axis.countTitle} (smoothed)`, axis: {} } : {}),
        ...(axis.yMode === 'logCount' ? { scale: { type: 'log', clamp: true } } : {}),
      },
      tooltip: [
        { field: 'value', type: 'quantitative', title: axis.label },
        { field: 'share', type: 'quantitative', title: 'Smoothed share', format: '.2%' },
      ],
    },
  } as unknown as TopLevelSpec;
}

/**
 * Small multiples: one histogram per group value. Rows carry a `group` column
 * alongside `lo`, `hi` and `count`. No brush; a faceted panel is a reference,
 * not a selector, and Vega-Lite forbids interval selections across facets.
 *
 * No legend: the facet header already names each group, which is a direct label
 * and the stronger channel.
 */
export function facetedHistogramSpec(
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
      mark: { ...BAR },
      encoding: {
        x: binnedX(axis),
        x2: { field: 'hi' },
        y: countAxis(axis),
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
