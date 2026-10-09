/**
 * Uploads over time, split by a group field. Rows are the `coverage`
 * procedure's buckets verbatim: `{ start, group, n }`.
 */

import type { TopLevelSpec } from 'vega-lite';
import type { Granularity } from '@mriqc/shared';
import type { PanelOptions } from '../../graph/state';
import {
  baseConfig,
  LIGHT_THEME,
  type ChartTheme,
  FILLS_CONTAINER,
  SERIES_LEGEND,
  VL_SCHEMA,
  groupRange,
} from './palette';

/** Dataset name the coverage projection fills in. */
export const COVERAGE_DATA = 'coverage';

/**
 * UTC units, not local ones. `start` is the UTC instant the server's
 * `date_trunc` produced, so flooring it with `getMonth()`/`getDate()` in the
 * browser's zone would move every bucket west of UTC one bucket early -- a
 * March upload drawn under February for anyone in the Americas.
 */
const TIME_UNIT: Record<Granularity, string> = {
  day: 'utcyearmonthdate',
  week: 'utcyearweek',
  month: 'utcyearmonth',
  year: 'utcyear',
};

/**
 * Stacked bars or a stacked area, over the same rows.
 *
 * A coverage panel is grouped by construction, so it always has the legend the
 * two-or-more-series rule asks for. The columns carry a 1px stroke in the
 * surface colour: that is the surface gap between touching segments of a stack,
 * which is the only separator a stacked bar gets -- never a stroke in a data
 * colour.
 */
export function coverageSpec(
  chart: 'stackedBar' | 'area' | 'line',
  /** Kept in the signature -- it is part of the panel's spec key -- but no
   * longer drawn: the card's meaning line names the grouping field. */
  groupLabel: string,
  granularity: Granularity,
  /** "Scans" or "Uploads", per the view; see `countAxisTitle`. */
  countTitle: string,
  options: Pick<PanelOptions, 'cumulative' | 'share' | 'coverageLogY'> = {
    cumulative: false,
    share: false,
    coverageLogY: false,
  },
  groups: readonly string[] = [],
  ordered = false,
  theme: ChartTheme = LIGHT_THEME,
): TopLevelSpec {
  void groupLabel;
  return {
    $schema: VL_SCHEMA,
    ...baseConfig(theme),
    ...FILLS_CONTAINER,
    data: { name: COVERAGE_DATA },
    mark:
      chart === 'line' ? { type: 'line', strokeWidth: 2 } : chart === 'area'
        ? { type: 'area', interpolate: 'monotone', line: false }
        : { type: 'bar', stroke: theme.surface, strokeWidth: 1 },
    encoding: {
      x: {
        field: 'start',
        type: 'temporal',
        timeUnit: TIME_UNIT[granularity],
        title: 'Upload date',
      },
      y: {
        field: 'n',
        type: 'quantitative',
        aggregate: 'sum',
        stack: chart === 'line' ? null : 'zero',
        title: options.share
          ? `Share of ${countTitle.toLowerCase()}`
          : options.cumulative
            ? `Cumulative ${countTitle}`
            : countTitle,
        axis: options.share ? { format: '.0%' } : undefined,
        scale: options.share
          ? { domain: [0, 1] }
          : options.coverageLogY
            ? { type: 'log', clamp: true }
            : undefined,
      },
      color: {
        field: 'group',
        type: 'nominal',
        // The card's meaning line already reads "by <field>"; a legend title repeats it.
        title: null,
        scale: {
          domain: groups,
          range: groupRange(groups, ordered, theme),
        },
        // Tighter than the shared legend: the grouping field is whatever the
        // user picked, and `manufacturer` alone has 26 spellings in this
        // corpus. Three columns at 10px with an 84px label cap is the widest
        // that still fits a three-column card -- a fourth column overflows the
        // card's right edge and crops its own labels, which is worse than a
        // tall legend.
        legend: {
          ...SERIES_LEGEND,
          columns: 0,
          labelFontSize: 12,
          labelLimit: 120,
          symbolSize: 36,
          columnPadding: 12,
          padding: 12,
        },
      },
    },
  } as unknown as TopLevelSpec;
}
