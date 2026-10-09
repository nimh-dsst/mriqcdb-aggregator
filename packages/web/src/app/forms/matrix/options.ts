
import type { MetricId } from '../../graph/state';
import { isValidMetric } from '@mriqc/shared';
import { defaultPanelOptions } from '../../graph/state';
import { optionSchema, type OptionSchema } from '../options';

export interface FormOptions {
  coefficient?: 'spearman' | 'pearson';
  family?: string;
  metrics?: readonly MetricId[];
  clusterOrder?: boolean;
}
export const options: OptionSchema<FormOptions> = optionSchema<FormOptions>({
  fields: ['coefficient', 'family', 'metrics', 'clusterOrder'] as const,
  defaults: () => ({ coefficient: defaultPanelOptions().coefficient, family: defaultPanelOptions().family, metrics: defaultPanelOptions().metrics, clusterOrder: defaultPanelOptions().clusterOrder }),
  url: ({ enumeration, bool, shortText, list, metricToken }) => [
      { slot: 16, field: 'coefficient', codec: enumeration(['spearman', 'pearson']), default: undefined },
      { slot: 17, field: 'family', codec: shortText, default: undefined },
      { slot: 18, field: 'metrics', codec: list(metricToken, 63), default: undefined },
      { slot: 23, field: 'clusterOrder', codec: bool, default: undefined }
  ],
  validate(options, panel, context) {
    if (options.clusterOrder !== undefined) options.clusterOrder = options.clusterOrder === true;
  if (options.coefficient !== undefined) options.coefficient = options.coefficient === 'pearson' ? 'pearson' : 'spearman';
  if (options.metrics !== undefined) options.metrics = Array.isArray(options.metrics) ? [...new Set(options.metrics)].filter(m => typeof m === 'string' && (!context.modality || isValidMetric(context.modality, m))).slice(0,24) : [];
  if (options.family !== undefined && typeof options.family !== 'string') delete options.family;
  },
});

