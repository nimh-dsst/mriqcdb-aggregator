import type { FormDef } from '../types';
import { commonDefinition } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';

export const ecdf: Omit<FormDef, 'options'> & { options: typeof options; id: 'ecdf' } = {
  ...commonDefinition,
  id: 'ecdf',
  label: 'ECDF', icon: 'chart-line', hint: 'Share at or below each value',
  glyph: 'M1 12H5V9H9V6H13V3H18V1',
  availability: single, options,
  queries: countQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? `Cumulative share of ${unit} uploaded by each date${across}.` : `Share of ${unit} at or below each value of ${metric}${across}.`,
  
};
