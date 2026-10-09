

import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  colorScale?: 'linear' | 'log' | 'sqrt';
  colorDomain?: 'auto' | readonly [number, number];
  cells?: 30 | 60 | 120;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['colorScale', 'colorDomain', 'cells'] as const,
  defaults: () => ({ colorScale: defaultPanelOptions().colorScale, colorDomain: defaultPanelOptions().colorDomain, cells: defaultPanelOptions().cells }),
  url: ({ enumeration, pair, roundedNumber }) => [
      { slot: 0, field: 'colorScale', codec: enumeration(['linear', 'log', 'sqrt']), default: undefined },
      { slot: 1, field: 'colorDomain', codec: pair(roundedNumber), default: 'auto' },
      { slot: 2, field: 'cells', codec: enumeration([30, 60, 120]), default: 60 }
  ],
  validate(options, panel, context) {
  if (options.colorScale !== undefined && !['linear', 'log', 'sqrt'].includes(options.colorScale)) delete options.colorScale;
  if (options.cells !== undefined && ![30, 60, 120].includes(options.cells)) delete options.cells;
  if (options.colorDomain !== undefined) {
    const domain = options.colorDomain;
    options.colorDomain = Array.isArray(domain) && domain.length === 2 && domain.every(Number.isFinite) && domain[0] < domain[1]
      ? [domain[0], domain[1]] : 'auto';
    if ((options.colorScale ?? context.colorScale) === 'log' && options.colorDomain !== 'auto' && options.colorDomain[0] <= 0) options.colorDomain = 'auto';
  }
  },
});

