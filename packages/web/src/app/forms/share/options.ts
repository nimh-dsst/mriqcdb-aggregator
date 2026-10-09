

import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  share: boolean;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['share'] as const,
  defaults: () => ({ share: defaultPanelOptions().share }),
  url: ({ optionDefault, bool }) => [
      { slot: 11, field: 'share', codec: bool, default: optionDefault('share') }
  ],
  validate(options, panel, context) {
  },
});

