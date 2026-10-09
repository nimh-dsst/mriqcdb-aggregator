import type { TopLevelSpec } from 'vega-lite';
import type { BoxSort } from '../../graph/state';
import { baseConfig, LIGHT_THEME, VL_SCHEMA, axisTitle, valueScale } from '../shared/palette';
import type { MetricAxis } from '../histogram/histogram';


import { COHORTS_DATA, type CohortSeries, cohortScale } from '../shared/comparison-primitives';

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
