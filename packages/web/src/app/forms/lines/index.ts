import { continuousChart } from '../shared/continuous';
import type { FormDef } from '../types';
import { commonDefinition, withProjection } from '../shared/definition';
import { paired } from '../availability';
import { pairedQueries } from '../shared/queries';
import { options } from './options';

export const lines: Omit<FormDef, 'options'> & { options: typeof options; id: 'lines' } = {
  ...commonDefinition,
  id: 'lines',
  label: 'Lines', icon: 'chart-line', hint: 'Three quantile lines per x bin',
  glyph: 'M1 6L6 1L12 3L19 1M1 9L6 5L12 7L19 4M1 13L6 10L12 12L19 8',
  availability: paired, options,
  queries: (state, panel, services) => pairedQueries(state, panel, services, true),
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? `${metric} over upload time: 5th, 50th and 95th percentiles${across}.` : `Spread of ${metric}${across}.`,
  spec: withProjection(continuousChart, 'time'),
};
