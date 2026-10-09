

import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  sampleSize?: number;
  seed?: number;
  k?: number;
  showPoints?: boolean;
  clusterSplit?: boolean;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['sampleSize', 'seed', 'k', 'showPoints', 'clusterSplit'] as const,
  defaults: () => ({ sampleSize: defaultPanelOptions().sampleSize, seed: defaultPanelOptions().seed, k: defaultPanelOptions().k, showPoints: defaultPanelOptions().showPoints, clusterSplit: defaultPanelOptions().clusterSplit }),
  url: ({ unsigned, bool, exactNumber }) => [
      { slot: 19, field: 'sampleSize', codec: exactNumber, default: undefined },
      { slot: 20, field: 'seed', codec: exactNumber, default: undefined },
      { slot: 21, field: 'k', codec: unsigned, default: undefined },
      { slot: 22, field: 'showPoints', codec: bool, default: undefined },
      { slot: 24, field: 'clusterSplit', codec: bool, default: undefined }
  ],
  validate(options, panel, context) {
  if (options.k !== undefined) options.k = Math.max(2, Math.min(8, Math.round(Number(options.k)) || 3));
  if (options.seed !== undefined) options.seed = Math.max(0, Math.min(2147483647, Math.round(Number(options.seed)) || 0));
  if (options.sampleSize !== undefined) options.sampleSize = Math.max(1, Math.min(20000, Math.round(Number(options.sampleSize)) || 20000));
  for (const key of ['showPoints','clusterSplit'] as const) if (options[key] !== undefined) options[key] = options[key] === true;
  },
});

