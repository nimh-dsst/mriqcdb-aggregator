import type { FormDef } from '../types';
import { commonDefinition } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';

export const box: Omit<FormDef, 'options'> & { options: typeof options; id: 'box' } = {
  ...commonDefinition,
  id: 'box',
  label: 'Box', icon: 'chart-candlestick', hint: 'Median and spread',
  glyph: 'M1 7H5M15 7H19M1 4V10M19 4V10M5 3H15V11H5ZM10 3V11',
  availability: single, options,
  queries: countQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? `Spread of upload dates, approximated from ${input.granularity} counts${across}.` : `Spread of ${metric}${across}.`,
  
};
