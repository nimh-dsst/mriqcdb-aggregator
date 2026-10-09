import type { TopLevelSpec } from 'vega-lite';
import { POPULATION_DATA, type MetricAxis } from '../histogram/histogram';
import { LIGHT_THEME, VL_SCHEMA, baseConfig, FILLS_CONTAINER, brushParam, axisTitle, valueScale } from '../shared/palette';

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

