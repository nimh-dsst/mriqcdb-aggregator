import { formDef } from '../../forms/registry';
import { type Panel, type State } from '../../graph/state';
import { correlationMetrics } from '../panels/correlation-options';

export function studyReady(state: State): boolean { return typeof state.study === 'object' && state.study.status === 'ready'; }

export function studyFormReason(panel: Panel, state: State): string | null {
  const study = state.study;
  if (typeof study !== 'object' || study.status !== 'ready') return null;
  const columns = study.columns ?? study.metrics;
  if (formDef(panel.form).metricSet) {
    const metrics = correlationMetrics(panel, state.global.modality);
    const available = metrics.filter(metric => study.metrics.includes(metric));
    if (panel.options.family === 'custom' && available.length !== metrics.length) return 'your file is missing a selected metric';
    return available.length < 2 ? 'your file needs at least two metrics in this set' : null;
  }
  if ((panel.x === 'created_at' || panel.y === 'created_at') && !columns.includes('created_at')) return 'your file has no upload time';
  for (const column of [panel.x, panel.y]) {
    if (column && !columns.includes(column)) return `your file has no ${column} column`;
  }
  return null;
}
