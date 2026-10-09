


import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {

}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: [] as const,
  defaults: () => ({  }),
  url: () => [
      
  ],
  validate(options, panel, context) {
  },
});

