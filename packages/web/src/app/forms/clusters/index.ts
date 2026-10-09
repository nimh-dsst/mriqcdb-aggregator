import { localKey } from './queries';
import type { FormDef } from '../types';
import { commonDefinition, timeMeaning } from '../shared/definition';
import { paired } from '../availability';
import { pairedQueries } from '../shared/queries';
import { options } from './options';

export const clusters: Omit<FormDef, 'options'> & { options: typeof options; id: 'clusters' } = {
  ...commonDefinition, localKey,
  id: 'clusters',
  label: 'Clusters', icon: 'shapes', hint: 'Exploratory groups in a sample',
  glyph: 'M2 10h.1M4 8h.1M6 11h.1M12 3h.1M15 2h.1M14 5h.1M17 11h.1M19 9h.1',
  availability: paired, options,
  queries: pairedQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => input.x === 'created_at' ? timeMeaning(input, unit, across) : `Spread of ${metric}${across}.`,
  memoize: false, densitySampleSize: panel => panel.options.sampleSize ?? 20000,
};
