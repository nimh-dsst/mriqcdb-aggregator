import { tableSpec } from './spec';
import type { FormDef } from '../types';
import { commonDefinition, withProjection } from '../shared/definition';
import { single } from '../availability';
import { tableQueries } from '../shared/queries';
import { options } from './options';

export const table: Omit<FormDef, 'options'> & { options: typeof options; id: 'table' } = {
  ...commonDefinition,
  id: 'table',
  label: 'Table', icon: 'table-2', hint: 'Individual records behind the chart',
  glyph: 'M1 1H19V13H1ZM1 5H19M1 9H19M7 1V13M13 1V13',
  availability: single, options,
  queries: tableQueries,
  brushable: false,
  meaning: (input, unit, metric, across) => `The individual ${unit} behind these charts, most recent first.`,
  spec: withProjection(tableSpec, 'analysis'),
  table: true, clip: false, countWithValue: false,
};
