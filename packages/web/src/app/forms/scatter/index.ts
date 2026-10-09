import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { paired } from '../availability';
import { pairedQueries } from '../shared/queries';
import { options } from './options';

export const scatter: Omit<FormDef, 'options'> & { options: typeof options; id: 'scatter' } = {
  ...commonDefinition,
  id: 'scatter',
  label: 'Scatter', icon: 'chart-scatter', hint: 'A sample of paired values',
  glyph: 'M3 11h.1M6 7h.1M9 10h.1M11 4h.1M15 6h.1M18 2h.1',
  availability: paired, options,
  queries: pairedQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Spread of ${metric}${across}.`,
  
};
