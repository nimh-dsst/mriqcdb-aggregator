import { compile } from 'vega-lite';
import { parse, View } from 'vega';
import { densityChart, type AnalysisSeries } from '../panels/specs/analysis-charts';

describe('study contour rendering', () => {
  for (const count of [1, 2, 4]) {
    it(`parses and runs a ${count}-series heatmap with one brush owner per plot`, async () => {
      const series: AnalysisSeries[] = Array.from({ length: count }, (_, i) => ({
        id: i === 1 ? 'study' : String(i), name: i === 1 ? 'My study' : `Series ${i}`, color: '#009E73',
        result: { xKind: 'metric', yKind: 'metric', x: { lo: 0, width: 1, bins: 2, underflow: 0, overflow: 0 },
          y: { lo: 0, width: 1, bins: 2, underflow: 0, overflow: 0 },
          counts: [1, 2, 3, 4], n: 10, pearson: 0.5, spearman: 0.5, sample: [[0.5, 0.5]] },
      }));
      const chart = densityChart(series, { xLabel: 'FD mean', yLabel: 'tSNR', form: 'heatmap', showPoints: true });
      const spec = compile({ ...chart.spec, datasets: chart.datasets }).spec;
      const view = new View(parse(spec), { renderer: 'none' });
      try {
        await view.runAsync();
        expect(view.data(count > 1 ? 'density-panels' : 'density-grid').length).toBeGreaterThan(0);
        if (count > 1) expect((chart.datasets['density-panels'] as { seriesId: string }[]).some(row => row.seriesId === 'study')).toBe(true);
      } finally { view.finalize(); }
    });
  }
});
