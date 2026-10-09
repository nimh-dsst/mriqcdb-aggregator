/**
 * A box plot built from server-side quantiles: one rule for the p05..p95
 * whiskers, one bar for the interquartile box, one tick for the median. Vega-
 * Lite's own `boxplot` mark needs raw values, which the wire never carries.
 */

import type { TopLevelSpec } from 'vega-lite';
import type { BoxSort } from '../../graph/state';
import {
  baseConfig,
  LIGHT_THEME,
  type ChartTheme,
  OTHER_COLOR,
  VL_SCHEMA,
  axisTitle,
  valueScale,
  groupRange,
} from '../shared/palette';
import { GROUPS_DATA, type MetricAxis } from '../histogram/histogram';

/**
 * One row per group: `{ group, p05, p25, p50, p75, p95, n }`. Row height is
 * fixed by `step` so a panel with fifty groups scrolls rather than squashes.
 *
 * No legend: the y axis names every group, which is a direct label and the
 * stronger identity channel. That direct label is also the relief the three
 * low-contrast slots of the categorical palette need (see `palette.ts`).
 */
export function boxSpec(
  axis: MetricAxis,
  groupLabel: string,
  sort: BoxSort = 'median',
  autoSymlog = false,
  domain: readonly [number, number] | null = null,
  groups: readonly string[] = [],
  ordered = false,
): TopLevelSpec {
  const theme = axis.theme ?? LIGHT_THEME;
  const scale = {
    ...(axis.xScale ? valueScale(axis.xScale, axis.xRange, axis.constant) : axis.logScale || autoSymlog
      ? { type: 'symlog', constant: 1, nice: true }
      : valueScale(false)),
    ...(Array.isArray(axis.xRange) ? { domain: [...axis.xRange] } : domain === null ? {} : { domain: [domain[0], domain[1]] }),
  };
  const x = {
    field: 'p25',
    type: 'quantitative',
    title: axisTitle(axis.label, axis.unit),
    // A box whose p05/p95 span fiftyfold has the same visual failure as a
    // metric explicitly flagged log-scale: the IQR becomes a hairline beside a
    // long whisker. Symlog keeps zero and negative values drawable while still
    // giving its interior useful room.
    scale,
  };
  const y = {
    field: 'group',
    type: 'nominal',
    title: groupLabel,
    sort: { field: sort === 'n' ? 'n' : 'p50', order: 'descending' },
  };
  const groupScale =
    groups.length === 0
      ? { range: [...theme.categories, OTHER_COLOR] }
      : { domain: groups, range: groupRange(groups, ordered, theme) };
  const rowEnd =
    domain === null ? { ...x, field: 'p95' } : { datum: domain[1], type: 'quantitative', scale };
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    width: 'container',
    height: { step: 22 },
    autosize: { type: 'fit-x', contains: 'padding' },
    data: { name: GROUPS_DATA },
    encoding: { y },
    layer: [
      {
        mark: { type: 'rule', color: theme.mutedInk, strokeWidth: 1, strokeCap: 'round' },
        encoding: {
          x: { ...x, field: 'p05' },
          x2: { field: 'p95' },
        },
      },
      {
        // A very small IQR is still a visible, cohort-coloured 3px mark. The
        // real box is drawn over it below; this tick remains at either side
        // when a zero-width or sub-pixel box would otherwise disappear.
        mark: { type: 'tick', thickness: 3, height: 12 },
        encoding: {
          x: { ...x, field: 'p50' },
          color: {
            field: 'group',
            type: 'nominal',
            scale: groupScale,
            legend: null,
          },
        },
      },
      {
        mark: { type: 'bar', height: 12, cornerRadius: 2 },
        encoding: {
          x,
          x2: { field: 'p75' },
          color: {
            field: 'group',
            type: 'nominal',
            scale: groupScale,
            legend: null,
          },
        },
      },
      {
        mark: { type: 'tick', color: theme.medianColor, thickness: 2, height: 14 },
        encoding: { x: { ...x, field: 'p50' } },
      },
      {
        // The y-axis tells the reader which row is which; the number at its
        // far end makes the ranking checkable without a tooltip.
        mark: {
          type: 'text',
          align: 'right',
          baseline: 'middle',
          dx: -3,
          color: theme.mutedInk,
          fontSize: 12,
        },
        encoding: {
          x: rowEnd,
          text: { field: 'n', type: 'quantitative', format: ',' },
        },
      },
    ],
  } as unknown as TopLevelSpec;
}
