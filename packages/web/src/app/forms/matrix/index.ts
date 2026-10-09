import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { metricSet } from '../availability';
import { matrixQueries } from '../shared/queries';
import { options } from './options';

export const matrix: Omit<FormDef, 'options'> & { options: typeof options; id: 'matrix' } = {
  ...commonDefinition,
  id: 'matrix',
  label: 'Matrix', icon: 'grid-2x2', hint: 'Relationships within a metric set',
  glyph: 'M1 1H19V13H1ZM7 1V13M13 1V13M1 5H19M1 9H19M2 2L6 4M8 6L12 8M14 10L18 12',
  availability: metricSet, options,
  queries: matrixQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Spread of ${metric}${across}.`,
  metricSet: true, clip: false,
  stats: () => null,
};
