import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { categorical } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';
import { shareChart } from './spec';

export const share: Omit<FormDef, 'options'> & { options: typeof options; id: 'share' } = {
  ...commonDefinition,
  id: 'share',
  label: 'Share', icon: 'chart-column', hint: 'Proportion in each category',
  glyph: 'M1 3H19V11H1ZM6 3V11M14 3V11',
  availability: categorical, options,
  queries: countQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Share of ${unit} per ${input.groupLabel ?? 'category'}${across}.`,
  categorySpec: shareChart,
};
