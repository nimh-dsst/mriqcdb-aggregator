/**
 * The four charts of a comparison panel: a smoothed density overlay, a step
 * histogram overlay, an overlaid ECDF, and one box per cohort.
 *
 * All four draw one dataset -- `COHORTS_DATA`, whose rows carry a `cohort`
 * column holding the cohort's **id** and a `label` column holding its name --
 * and encode it with a colour scale whose domain is the ids and whose range is
 * their palette hues. One dataset and not one layer per cohort, because the
 * cohort list is state: a layered spec would have to be rebuilt (and the chart
 * re-embedded, losing the brush) every time a cohort was added, and its colour
 * scale would have to be assembled from the layers rather than declared once.
 *
 * Keyed on the id and not the name, because two cohorts can legitimately share
 * a name -- two unnamed ones are both "Cohort", two duplicates of one base are
 * both "X copy" -- and keying on the name merged them into a single series: one
 * ECDF line zigzagging through both curves, two boxes on one row, one legend
 * entry, and a colour scale whose domain had collapsed to one value. The legend
 * and the axis show `label`; everything that distinguishes a series uses the id.
 *
 * Every share is of the cohort's **own** scans. Cohorts differ in size by orders
 * of magnitude -- a 400-scan study against 778,075 -- so raw counts overlaid make
 * the smaller cohort a flat line along the axis. "Share of scans" is the only
 * y axis on which two cohorts are comparable, which is why it is the axis title
 * and not a footnote.
 */

import type { TopLevelSpec } from 'vega-lite';
import type { BoxSort } from '../../graph/state';
import {
  themedColor,
  baseConfig,
  LIGHT_THEME,
  type ChartTheme,
  FILLS_CONTAINER,
  SERIES_LEGEND,
  VL_SCHEMA,
  axisTitle,
  brushParam,
  valueScale,
} from './palette';
import type { MetricAxis } from './histogram';
import { cohortBinRows, type CohortResult } from './rows';

export function stackedRows(results: readonly CohortResult[], order: readonly string[], normalized: boolean) {
  const rows = cohortBinRows(results).filter(row => row.hi > row.lo);
  const bins = [...new Set(rows.map(row => row.lo))].sort((a, b) => a - b);
  return bins.flatMap(lo => {
    const bin = rows.filter(row => row.lo === lo).sort((a, b) => order.indexOf(a.cohort) - order.indexOf(b.cohort));
    const total = bin.reduce((sum, row) => sum + row.count, 0);
    let y = 0;
    return bin.map(row => {
      const value = normalized ? total ? row.count / total : 0 : row.count;
      const out = { ...row, share: total ? row.count / total : 0, y0: y, y1: y + value };
      y += value;
      return out;
    });
  });
}

export function stackedHistogram(axis: MetricAxis, cohorts: readonly CohortSeries[], results: readonly CohortResult[], normalized: boolean) {
  const theme = axis.theme ?? LIGHT_THEME;
  const seriesColor = cohortScale(cohorts, true, theme);
  // Filled bars need filled swatches; stroke symbols inherit no visible stroke.
  const color = { ...seriesColor, legend: { ...seriesColor.legend, orient: 'top', symbolType: 'square' } };
  const spec = { $schema: VL_SCHEMA, ...baseConfig(theme), ...FILLS_CONTAINER,
    data: { name: COHORTS_DATA }, mark: { type: 'bar', binSpacing: 0, clip: true },
    encoding: {
      x: { field: 'lo', type: 'quantitative', bin: { binned: true }, title: axisTitle(axis.label, axis.unit), scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant) },
      x2: { field: 'hi' },
      y: { field: 'y1', type: 'quantitative', title: normalized ? 'Share of bin' : axis.countTitle,
        ...(normalized ? { axis: { format: '.0%' }, scale: { domain: [0, 1] } } : {}) },
      y2: { field: 'y0' }, color, tooltip: shareTooltip(axis, true),
    } } as unknown as TopLevelSpec;
  return { spec, rows: stackedRows(results, color.scale.domain, normalized) };
}

/** The one dataset every comparison chart reads. Rows carry a `cohort` id and a `label`. */
export const COHORTS_DATA = 'cohorts';

/** A cohort as a chart knows it: an id to key on, a name to show, a hue to draw in. */
export interface CohortSeries {
  id: string;
  label: string;
  color: string;
}

/**
 * The y-axis title of a share-normalized chart, in the view's own noun: "Share
 * of scans" on a policy view, "Share of uploads" on `raw`.
 *
 * Derived from `MetricAxis.countTitle` rather than hard-coded, so the one rule
 * the copy pass established -- the unit is named once, in the view's own noun --
 * holds here too.
 */
export function shareAxisTitle(countTitle: string): string {
  return `Share of ${countTitle.toLowerCase()}`;
}

/** The same axis for a smoothed curve, which is an estimate and says so. */
export function densityAxisTitle(countTitle: string): string {
  return `${shareAxisTitle(countTitle)} (smoothed)`;
}

/**
 * The colour channel every comparison chart shares: the cohort ids in panel
 * order against their palette hues, with the legend `ui-style.md` asks for at
 * two series or more.
 *
 * The domain is declared rather than inferred so a cohort whose query has not
 * landed yet still holds its slot in the legend and its hue -- the legend is the
 * panel's statement of what it is comparing, and it must not reshuffle as
 * results arrive. `labelExpr` maps each id back to its name, because the domain
 * has to be the id while the legend has to read as English.
 *
 * The swatch is a stroke and not a square: every comparison chart is now a line
 * or an outlined area, and a filled square claims a solidity the 25% fills do
 * not have.
 */
function cohortScale(cohorts: readonly CohortSeries[], legend: boolean, theme: ChartTheme) {
  cohorts = [...cohorts].sort((a, b) => {
    const slot = (color: string) => {
      const i = theme.categories.indexOf(themedColor(color, theme));
      return i < 0 ? theme.categories.length : i;
    };
    return slot(a.color) - slot(b.color);
  });
  const labels = cohorts.map((cohort) => `datum.value === ${JSON.stringify(cohort.id)} ? ${JSON.stringify(cohort.label)}`);
  return {
    field: 'cohort',
    type: 'nominal' as const,
    scale: {
      domain: cohorts.map((cohort) => cohort.id),
      range: cohorts.map((cohort) => themedColor(cohort.color, theme)),
    },
    ...(legend
      ? {
          legend: {
            ...SERIES_LEGEND,
            symbolType: 'stroke',
            symbolStrokeWidth: 2,
            labelExpr: `${labels.join(' : ')}${labels.length > 0 ? " : datum.value" : 'datum.value'}`,
          },
        }
      : { legend: null }),
  };
}

/** What a tooltip on a comparison mark says: which cohort, where, and the share. */
function shareTooltip(axis: MetricAxis, withCount: boolean) {
  const tooltip: Record<string, unknown>[] = [
    { field: 'label', type: 'nominal', title: 'Cohort' },
    { field: 'range', type: 'nominal', title: 'Range' },
    { field: 'share', type: 'quantitative', title: 'Share', format: '.2%' },
  ];
  // The count is beside the share wherever there is one, because a share alone
  // cannot be sanity checked -- 4% of a cohort is 30 scans or 30,000 depending
  // on the cohort, and the reader is entitled to know which. A smoothed curve
  // has no count: its value is a weighted average over neighbouring bins.
  if (withCount) tooltip.push({ field: 'count', type: 'quantitative', title: axis.countTitle, format: ',' });
  return tooltip;
}

/** 2px, round join and cap: the outline every area and line here wears. */
const OUTLINE = { strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round' } as const;

/** The translucency of a filled area, so a cohort behind another stays readable. */
const FILL_OPACITY = 0.25;

/**
 * Two or more cohorts' histograms over the same bin edges, each normalized to a
 * share of its own scans and drawn as a translucent step area with a 2px step
 * outline.
 *
 * Step areas and not grouped bars. Thin bars side by side within each bin read
 * as zebra striping at any useful bin count -- the eye follows the alternation
 * rather than either distribution -- and the shape of a histogram is a silhouette,
 * which is what an outlined area draws. The fill is what lets two silhouettes
 * overlap and still be read; the outline is what keeps each one followable
 * through the overlap.
 *
 * `step-after` over each bin's lower edge is exactly the histogram outline: the
 * value holds from `lo` to the next `lo`, and the row builder emits a closing
 * point at the final `hi` so the last bin is drawn full width and the area shuts
 * against the baseline.
 */
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
export function cohortBoxSpec(
  axis: MetricAxis,
  cohorts: readonly CohortSeries[],
  sort: BoxSort = 'median',
  autoSymlog = false,
  domain: readonly [number, number] | null = null,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  const scale = {
    ...(axis.xScale ? valueScale(axis.xScale, axis.xRange, axis.constant) : axis.logScale || autoSymlog ? { type: 'symlog', constant: 1, nice: true } : valueScale(false)),
    ...(Array.isArray(axis.xRange) ? { domain: [...axis.xRange] } : domain === null ? {} : { domain: [domain[0], domain[1]] }),
  };
  const x = {
    field: 'p25',
    type: 'quantitative',
    title: axisTitle(axis.label, axis.unit),
    scale,
  };
  const rowEnd = domain === null
    ? { ...x, field: 'p95' }
    : { datum: domain[1], type: 'quantitative', scale };
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    width: 'container',
    // Taller rows than the grouped box plot's 22px: a comparison has a handful
    // of cohorts rather than fifty groups, so the card's height is better spent
    // on readable boxes than on empty space.
    height: { step: 34 },
    autosize: { type: 'fit-x', contains: 'padding' },
    data: { name: COHORTS_DATA },
    encoding: {
      y: {
        field: 'cohort',
        type: 'nominal',
        title: null,
        sort: { field: sort === 'n' ? 'n' : 'p50', order: 'descending' },
        // The row is keyed by id; the tick reads as the cohort's name.
        axis: {
          labelExpr: cohorts
            .map(
              (cohort) =>
                `datum.value === ${JSON.stringify(cohort.id)} ? ${JSON.stringify(cohort.label)}`,
            )
            .concat('datum.value')
            .join(' : '),
        },
      },
      tooltip: [
        { field: 'label', type: 'nominal', title: 'Cohort' },
        { field: 'p05', type: 'quantitative', title: '5th pct' },
        { field: 'p50', type: 'quantitative', title: 'Median' },
        { field: 'p95', type: 'quantitative', title: '95th pct' },
        { field: 'n', type: 'quantitative', title: axis.countTitle, format: ',' },
      ],
    },
    layer: [
      {
        mark: { type: 'rule', color: theme.mutedInk, strokeWidth: 1, strokeCap: 'round' },
        encoding: { x: { ...x, field: 'p05' }, x2: { field: 'p95' } },
      },
      {
        mark: { type: 'tick', thickness: 3, height: 16 },
        encoding: { x: { ...x, field: 'p50' }, color: cohortScale(cohorts, false, theme) },
      },
      {
        mark: { type: 'bar', height: 16, cornerRadius: 2 },
        encoding: { x, x2: { field: 'p75' }, color: cohortScale(cohorts, false, theme) },
      },
      {
        mark: { type: 'tick', color: theme.medianColor, thickness: 2, height: 20 },
        encoding: { x: { ...x, field: 'p50' } },
      },
      {
        mark: { type: 'text', align: 'right', baseline: 'middle', dx: -3, color: theme.mutedInk, fontSize: 12 },
        encoding: { x: rowEnd, text: { field: 'n', type: 'quantitative', format: ',' } },
      },
    ],
  } as unknown as TopLevelSpec;
}
