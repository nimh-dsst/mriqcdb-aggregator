import { asColumnId, isValidMetric, metricsFor, type Modality } from '@mriqc/shared';
import type { Panel } from './state';

export function defaultCorrelationMetrics(modality: Modality) {
  const ids = modality === 'bold'
    ? ['fd_mean', 'dvars_std', 'tsnr', 'snr', 'efc', 'fber', 'gsr_x', 'aor']
    : ['snr_total', 'cnr', 'efc', 'fber', 'cjv', 'wm2max', 'inu_med', 'qi_1'];
  return ids.map(asColumnId).filter(id => isValidMetric(modality, id));
}

export function correlationMetrics(panel: Pick<Panel, 'options'>, modality: Modality) {
  if (panel.options.metrics !== undefined) return panel.options.metrics;
  if (panel.options.family && panel.options.family !== 'custom') {
    return metricsFor(modality).filter(metric => metric.family === panel.options.family).map(metric => metric.id).slice(0, 24);
  }
  return defaultCorrelationMetrics(modality);
}
