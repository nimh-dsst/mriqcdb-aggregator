import type { ColumnId, Filter } from '@mriqc/shared';

const PREFIX = 'bin:';
/** Values descriptors encode half-open numeric intervals, rather than requiring a new server procedure. */
export function splitValues(cuts: readonly number[]): readonly string[] {
  const points = [...new Set(cuts.filter(Number.isFinite))].sort((a, b) => a - b);
  if (!points.length || points.length > 4) return [];
  const edges: (number | null)[] = [null, ...points, null];
  return edges.slice(0, -1).map((lo, index) => PREFIX + JSON.stringify([lo, edges[index + 1]]));
}
export function splitBounds(value: string): readonly [number | null, number | null] | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const bounds = JSON.parse(value.slice(PREFIX.length));
    return Array.isArray(bounds) && bounds.length === 2 && bounds.every(item => item === null || typeof item === 'number' && Number.isFinite(item))
      && (bounds[0] === null || bounds[1] === null || bounds[0] < bounds[1]) ? [bounds[0], bounds[1]] : null;
  } catch { return null; }
}
function below(value: number): number {
  if (value === 0) return -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (value > 0 ? -1n : 1n));
  return view.getFloat64(0);
}
export function splitFilter(field: ColumnId, value: string): Filter | null {
  const bounds = splitBounds(value);
  return bounds ? { field, op: 'between', lo: bounds[0] ?? -Number.MAX_VALUE,
    hi: bounds[1] === null ? Number.MAX_VALUE : below(bounds[1]) } : null;
}
export function splitLabel(value: string): string {
  const bounds = splitBounds(value);
  return !bounds ? value : bounds[0] === null ? `< ${bounds[1]}` : bounds[1] === null ? `≥ ${bounds[0]}` : `${bounds[0]} – < ${bounds[1]}`;
}
