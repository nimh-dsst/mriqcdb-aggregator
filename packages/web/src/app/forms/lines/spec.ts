import { bandChart } from '../band/band';
export const linesChart = (series: Parameters<typeof bandChart>[0], yLabel: string, axis: Parameters<typeof bandChart>[2],
  quantiles: Parameters<typeof bandChart>[4], yScale: Parameters<typeof bandChart>[5]) =>
  bandChart(series, yLabel, axis, 'lines', quantiles, yScale);
