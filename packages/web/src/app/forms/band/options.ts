

import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  quantiles: 'quartiles' | 'tails';
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['quantiles'] as const,
  defaults: () => ({ quantiles: defaultPanelOptions().quantiles }),
  url: ({ enumeration, optionDefault }) => [
      { slot: 3, field: 'quantiles', codec: enumeration(['quartiles', 'tails'], 1), default: optionDefault('quantiles') }
  ],
  validate(options, panel, context) {
  options.quantiles = options.quantiles === 'tails' ? 'tails' : 'quartiles';
  },
});

