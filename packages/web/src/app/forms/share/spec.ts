import { categoryChart } from '../bars/categories';
export const shareChart: typeof categoryChart = (series, label, _share, title, theme) =>
  categoryChart(series, label, true, title, theme);
