

import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  bins: number;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['bins'] as const,
  defaults: () => ({ bins: defaultPanelOptions().bins }),
  url: ({ clampBins, unsigned, optionDefault }) => [
      { slot: 4,
    field: 'bins',
    codec: {
      write: (w, v) => unsigned.write(w, clampBins(v)),
      read: (r) => clampBins(unsigned.read(r)),
    },
    default: optionDefault('bins'),
  }
  ],
  validate(options, panel, context) {
  options.bins = context.clampBins(options.bins);
  },
});

