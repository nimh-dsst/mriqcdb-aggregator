import { fieldsFor, metricsFor, queryKey, type ColumnId, type CoverageResult } from '@mriqc/shared';
import type { State } from '../graph/state';
import { correlationMetrics } from '../graph/correlation-options';
import { activeView, viewNoun } from '../view/text';

export function exportCountQuery(state: State) {
  return { source: 'population' as const, proc: 'coverage' as const, ...state.global,
    group: 'manufacturer' as ColumnId, granularity: 'month' as const,
    selections: state.selections.map(({ metric, range }) => ({ metric, range })) };
}

export function exportView(state: State) {
  const { modality, view } = state.global;
  const fields = fieldsFor(modality, view, 'export');
  const metrics = metricsFor(modality);
  const visible = new Set(state.panels.flatMap<string>(panel => panel.form === 'matrix'
    ? correlationMetrics(panel, modality) : [panel.x, ...(panel.y ? [panel.y] : [])]));
  const defaults = new Set(['id', 'created_at', 'manufacturer', ...visible]);
  const groups = [{ family: 'Fields', fields: fields.map(field => ({ id: field.id, label: field.label })) },
    ...[...new Set(metrics.map(metric => metric.family))].map(family => ({ family,
      fields: metrics.filter(metric => metric.family === family).map(metric => ({ id: metric.id, label: metric.label })) }))];
  const columns = groups.flatMap(group => group.fields.map(field => field.id));
  const entry = state.datasets[queryKey(exportCountQuery(state))];
  const rows = entry?.status === 'ready' && entry.version === state.dataVersion
    ? (entry.result as CoverageResult).buckets.reduce((sum, bucket) => sum + bucket.n, 0) : null;
  return { groups, columns, metrics: metrics.map(metric => metric.id),
    defaults: columns.filter(id => defaults.has(id)), rows,
    scope: `${rows === null ? 'Counting' : rows.toLocaleString('en-US')} ${viewNoun(modality, activeView(state))}, current filters and brushes`,
    study: state.panels.some(panel => panel.series.some(series => series.kind === 'study' || series.kind === 'cohort' && state.cohorts.some(cohort => cohort.id === series.id && cohort.source === 'study'))),
    export: state.export };
}
