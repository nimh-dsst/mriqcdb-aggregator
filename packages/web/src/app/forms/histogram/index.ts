import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';

export const histogram: Omit<FormDef, 'options'> & { options: typeof options; id: 'histogram' } = {
  ...commonDefinition,
  id: 'histogram',
  label: 'Histogram', icon: 'chart-column', hint: 'Counts in equal-width bins',
  glyph: 'M1 13V9H5V13M5 13V4H9V13M9 13V1H13V13M13 13V6H17V13',
  availability: single, options,
  queries: countQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `How many ${unit} fall in each range of ${metric}${across}.`,
  stacked: true,
};
