import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { paired } from '../availability';
import { pairedQueries } from '../shared/queries';
import { options } from './options';

export const heatmap: Omit<FormDef, 'options'> & { options: typeof options; id: 'heatmap' } = {
  ...commonDefinition,
  id: 'heatmap',
  label: 'Heatmap', icon: 'grid-2x2', hint: 'Density across paired values',
  glyph: 'M1 1H6V6H1ZM8 1H13V6H8ZM8 8H13V13H8ZM15 8H19V13H15Z',
  availability: paired, options,
  queries: pairedQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Spread of ${metric}${across}.`,
  
};
