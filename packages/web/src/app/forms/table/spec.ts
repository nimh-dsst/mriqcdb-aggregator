const EMPTY_DATASETS: Readonly<Record<string, readonly unknown[]>> = {};
import type { ChartOutput } from '../shared/select';

export function sampleChart(): ChartOutput {
  return { spec: null, datasets: EMPTY_DATASETS, brushable: false, n: null };
}
export { sampleChart as tableSpec };
