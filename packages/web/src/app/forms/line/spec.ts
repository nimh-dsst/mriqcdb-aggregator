import { countsSpec } from './counts';
export const lineSpec = (axis: Parameters<typeof countsSpec>[0], cohorts: Parameters<typeof countsSpec>[2], layout: Parameters<typeof countsSpec>[3]) =>
  countsSpec(axis, 'line', cohorts, layout);
