import { categoryChart } from '../bars/categories';
import { continuousChart } from './continuous';
import type { FormDef, FormSpec, ProjectionInput } from '../types';
export const commonDefinition = {
  categorySpec: (series, label, _share, title, theme) => categoryChart(series, label, false, title, theme),
  spec: withProjection(continuousChart, 'analysis'),
  stats: (state, panel, keys, derive) => derive(state, panel, keys),
  table: false, metricSet: false, countBand: false, stacked: false,
  memoize: true, clip: true, countWithValue: true,
  distributionBins: panel => panel.options.bins,
  densitySampleSize: () => 2000,
} satisfies Partial<FormDef>;
export function timeMeaning(input: Parameters<FormDef['meaning']>[0], unit: string, across: string): string {
  return `${unit[0].toUpperCase() + unit.slice(1)} uploaded per ${input.granularity}${across}.`;
}

/** Graph services arrive at call time, keeping registry initialization acyclic. */
export function withProjection(chart: typeof continuousChart, projection: keyof ProjectionInput['projections']): FormSpec {
  return ((input: Parameters<typeof continuousChart>[0] | ProjectionInput, coverage?: Parameters<typeof continuousChart>[1]) =>
    'state' in input ? input.projections[projection](input.state, input.panel, input.theme) : chart(input, coverage)) as FormSpec;
}
