import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { retired } from '../availability';
import { pairedQueries } from '../shared/queries';
import { options } from './options';

export const hexbin: Omit<FormDef, 'options'> & { options: typeof options; id: 'hexbin' } = {
  ...commonDefinition,
  id: 'hexbin',
  label: 'Hexbin', icon: 'hexagon', hint: 'Sample counts in hexagonal cells',
  glyph: 'M3 3L6 1L9 3V7L6 9L3 7ZM9 7L12 5L15 7V11L12 13L9 11ZM15 3L18 1L20 3V7L18 9L15 7',
  availability: retired, options,
  queries: pairedQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Spread of ${metric}${across}.`,
  
};
