import { getAuthoredCatalog } from '@mriqc/shared';
import type { ColumnRef, MetricId } from '../graph/state';
import type { Availability, FormDef } from './types';
export type AxisType = 'numeric' | 'time' | 'categorical' | 'metrics';
export function axisType(x: ColumnRef | readonly MetricId[]): AxisType {
  if (Array.isArray(x)) return 'metrics';
  if (x === 'created_at') return 'time';
  return getAuthoredCatalog().fields.some(field => field.id === x && field.kind === 'categorical')
    ? 'categorical' : 'numeric';
}
export const single: FormDef['availability'] = (x, y) =>
  ['numeric', 'time'].includes(axisType(x)) && y === null ? { state: 'enabled' } : { state: 'hidden' };
export const paired: FormDef['availability'] = (x, y) =>
  !['numeric', 'time'].includes(axisType(x)) ? { state: 'hidden' }
    : y !== null ? { state: 'enabled' } : { state: 'disabled', reason: 'add a second column' };
export const categorical: FormDef['availability'] = x =>
  ({ state: axisType(x) === 'categorical' ? 'enabled' : 'hidden' });
export const metricSet: FormDef['availability'] = x =>
  ({ state: axisType(x) === 'metrics' ? 'enabled' : 'hidden' });
export const bandAvailability: FormDef['availability'] = (x, y, series) =>
  axisType(x) === 'time' && y === null ? { state: 'enabled' } : paired(x, y, series);
export const retired: FormDef['availability'] = () => ({ state: 'hidden' });
