
import type { BoxSort } from '../../graph/state';
import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  boxSort: BoxSort;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['boxSort'] as const,
  defaults: () => ({ boxSort: defaultPanelOptions().boxSort }),
  url: ({ enumeration, optionDefault }) => [
      { slot: 15, field: 'boxSort', codec: enumeration(['median', 'n']), default: optionDefault('boxSort') }
  ],
  validate(options, panel, context) {
  options.boxSort = options.boxSort === 'n' ? 'n' : 'median';
  },
});

