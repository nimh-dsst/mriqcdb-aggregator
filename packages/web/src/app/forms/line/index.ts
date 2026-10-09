import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';

export const line: Omit<FormDef, 'options'> & { options: typeof options; id: 'line' } = {
  ...commonDefinition,
  id: 'line',
  label: 'Line', icon: 'chart-line', hint: 'Counts per bin as a line',
  glyph: 'M1 11L5 8L9 10L14 3L19 1',
  availability: single, options,
  queries: countQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Number of ${unit} per bin of ${metric}${across}.`,
  stacked: true,
};
