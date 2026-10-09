import { countsSpec } from '../line/counts';
export const areaSpec = (axis: Parameters<typeof countsSpec>[0], cohorts: Parameters<typeof countsSpec>[2], layout: Parameters<typeof countsSpec>[3]) =>
  countsSpec(axis, 'area', cohorts, layout);
