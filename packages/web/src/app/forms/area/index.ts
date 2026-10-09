import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';

export const area: Omit<FormDef, 'options'> & { options: typeof options; id: 'area' } = {
  ...commonDefinition,
  id: 'area',
  label: 'Area', icon: 'chart-area', hint: 'Trend; stacked share with series',
  glyph: 'M1 13V10L5 7L9 9L14 3L19 1V13Z',
  availability: single, options,
  queries: countQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `${(input.cohortCount ?? 0) > 1 ? 'Share' : 'Number'} of ${unit} per bin of ${metric}${across}.`,
  stacked: true,
};
