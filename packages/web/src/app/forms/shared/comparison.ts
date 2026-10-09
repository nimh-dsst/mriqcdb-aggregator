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
import type { MetricAxis } from '../histogram/histogram';
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

export * from './comparison-primitives';
import { COHORTS_DATA, type CohortSeries, cohortScale, shareTooltip } from './comparison-primitives';
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

export { overlaidHistogramSpec } from '../histogram/comparison';
export { overlaidDensitySpec } from '../density/comparison';
export { overlaidEcdfSpec } from '../ecdf/comparison';
export { cohortBoxSpec } from '../box/comparison';
