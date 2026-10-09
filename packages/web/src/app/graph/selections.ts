import { isValidMetric, type Modality, type Selection } from '@mriqc/shared';

/** The common ingress rule for saved ranges and linked brushes. */
export function validSelections<T extends Selection>(values: readonly T[], modality: Modality): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    if (!value || !isValidMetric(modality, value.metric) || seen.has(value.metric) ||
        !Array.isArray(value.range) || value.range.length !== 2 || !value.range.every(Number.isFinite)) return false;
    seen.add(value.metric);
    return true;
  }).slice(0, 4).map(value => ({ ...value, range: [...value.range].sort((a, b) => a - b) as [number, number] }));
}
