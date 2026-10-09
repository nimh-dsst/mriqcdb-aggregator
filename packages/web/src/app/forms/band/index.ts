import { continuousChart } from '../shared/continuous';
import type { FormDef } from '../types';
import { commonDefinition, withProjection } from '../shared/definition';
import { bandAvailability } from '../availability';
import { bandQueries } from '../shared/queries';
import { options } from './options';

export const band: Omit<FormDef, 'options'> & { options: typeof options; id: 'band' } = {
  ...commonDefinition,
  id: 'band',
  label: 'Band', icon: 'chart-area', hint: 'Median with a quantile band per x bin',
  glyph: 'M1 9L6 3L12 5L19 1V7L12 11L6 9L1 13ZM1 11L6 6L12 8L19 4',
  availability: bandAvailability, options,
  queries: bandQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? `${metric} over upload time: median and middle half${across}.` : `Spread of ${metric}${across}.`,
  spec: withProjection(continuousChart, 'time'),
  countBand: true,
};
