import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { categorical } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';
import { categoryChart } from '../bars/categories';

export const bars: Omit<FormDef, 'options'> & { options: typeof options; id: 'bars' } = {
  ...commonDefinition,
  id: 'bars',
  label: 'Bars', icon: 'chart-column', hint: 'Counts per bucket; stacked with series',
  glyph: 'M2 13V7H5V13ZM8 13V2H11V13ZM14 13V5H17V13Z',
  availability: categorical, options,
  queries: countQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Number of ${unit} per ${input.groupLabel ?? 'category'}${across}.`,
  categorySpec: (series, label, _share, title, theme) => categoryChart(series, label, false, title, theme),
};
