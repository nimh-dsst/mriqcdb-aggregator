import type { FormDef } from '../types';
import { commonDefinition } from '../shared/definition';
import { single } from '../availability';
import { countQueries } from '../shared/queries';
import { options } from './options';
import { DENSITY_BINS } from '../../graph/state';

export const density: Omit<FormDef, 'options'> & { options: typeof options; id: 'density' } = {
  ...commonDefinition,
  id: 'density',
  label: 'Density', icon: 'chart-area', hint: 'Smoothed distribution of values',
  glyph: 'M1 12C5 12 5 2 10 2S15 12 19 12',
  availability: single, options,
  queries: countQueries,
  brushable: true,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? `Smoothed ${unit} counts per ${input.granularity}${across}.` : `Smoothed share of ${unit} at each value of ${metric}${across}.`,
  distributionBins: () => DENSITY_BINS,
};
