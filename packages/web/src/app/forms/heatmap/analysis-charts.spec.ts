import type { CorrelationResult, Density2dResult } from "@mriqc/shared";
import { compile } from 'vega-lite';

import { clustersChart, correlationChart, densityChart, type AnalysisSeries } from "./analysis-charts";

const density = {
  x: { lo: 0, width: 1, bins: 2, underflow: 0, overflow: 0 },
  y: { lo: 10, width: 2, bins: 2, underflow: 0, overflow: 0 },
  counts: [1, 2, 3, 4],
  n: 10,
  pearson: 0.4,
  spearman: 0.3,
  sample: [
    [0.2, 10.4],
    [0.4, 10.6],
    [1.6, 12.4],
  ],
} as unknown as Density2dResult;

const series: AnalysisSeries[] = [{ id: "all", name: "All subjects", color: "#0072B2", result: density }];

describe("analysis chart specifications", () => {
  it('applies both axis scales and ranges to cluster points and centroids', () => {
    const chart = clustersChart([[1, 2]], { assignments: [0], centroids: [[1, 2]], clusters: [], silhouette: null },
      'X', 'Y', undefined, 'log', { xRange: [1, 5], yScale: 'symlog', yRange: [-1, 3] });
    const compiled = compile({ ...chart.spec, datasets: chart.datasets } as never).spec;
    expect(compiled.scales?.find(scale => scale.name === 'x')).toMatchObject({ type: 'log', domain: [1, 5] });
    expect(compiled.scales?.find(scale => scale.name === 'y')).toMatchObject({ type: 'symlog', domain: [-1, 3] });
  });
  it.each(['heatmap', 'hexbin'] as const)('uses the selected scale/domain and names it on the %s color legend', form => {
    for (const colorScale of ['linear', 'log', 'sqrt'] as const) {
      const chart = densityChart(series, { xLabel: 'X', yLabel: 'Y', form, showPoints: false, colorScale, colorDomain: [1, 20], cells: 30 });
      const compiled = compile({ ...chart.spec, datasets: chart.datasets } as never).spec;
      const color = compiled.scales?.find(scale => scale.name.includes('color'));
      expect(color).toMatchObject({ type: colorScale, domain: [1, 20] });
      expect(compiled.legends?.some(legend => legend.title === `Count (${colorScale})`)).toBe(true);
    }
  });

  it('uses a linear coefficient legend by default and applies custom matrix color settings', () => {
    const result = { metrics: ['a', 'b'], pearson: [[1, 0.6], [0.6, 1]], spearman: [[1, 0.5], [0.5, 1]], pairN: [[20, 20], [20, 20]], minPairN: 20 } as unknown as CorrelationResult;
    const baseline = correlationChart(result, {}, false);
    const defaults = compile({ ...baseline.spec, datasets: baseline.datasets } as never).spec;
    expect(defaults.legends?.[0].title).toBe('Spearman ρ (linear)');
    for (const colorScale of ['linear', 'log', 'sqrt'] as const) {
      const chart = correlationChart(result, {}, false, undefined, 'pearson', { colorScale, colorDomain: [0.1, 0.9] });
      const compiled = compile({ ...chart.spec, datasets: chart.datasets } as never).spec;
      const color = compiled.scales?.find(scale => scale.name.includes('color')) as { type: string; domain: number[] };
      expect(color.type).toBe(colorScale);
      expect(color.domain[0]).toBeCloseTo(0.1);
      expect(color.domain.at(-1)).toBeCloseTo(0.9);
      expect(compiled.legends?.[0].title).toBe(`Pearson r (${colorScale})`);
    }
  });
  it('compiles a populated correlation matrix through Vega-Lite', () => {
    const result = { metrics: ['fd_mean','tsnr'], pearson: [[1,-0.6],[-0.6,1]], spearman: [[1,-0.5],[-0.5,1]], pairN: [[20,20],[20,20]], minPairN: 20 } as unknown as CorrelationResult;
    const chart = correlationChart(result, { fd_mean: 'FD mean', tsnr: 'tSNR' }, false);
    expect(() => compile({ ...chart.spec, datasets: chart.datasets } as never)).not.toThrow();
    expect(compile({ ...chart.spec, datasets: chart.datasets } as never).spec.axes?.length).toBeGreaterThanOrEqual(2);
  });
  it("exposes a clipped density grid and a named x/y brush", () => {
    const chart = densityChart(series, {
      xLabel: "SNR",
      yLabel: "CNR",
      form: "heatmap",
      showPoints: true,
    });
    const spec = chart.spec as unknown as { layer: { params: { name: string; select: { encodings: string[] } }[] }[] };

    expect(chart.datasets["density-grid"]).toHaveLength(4);
    expect(spec.layer[0].params[0]).toEqual({ name: "brush2d", select: { type: "interval", encodings: ["x", "y"] } });
  });

  it("hex-bins retained samples instead of treating density counts as samples", () => {
    const chart = densityChart(series, {
      xLabel: "SNR",
      yLabel: "CNR",
      form: "hexbin",
      showPoints: false,
    });
    const rows = chart.datasets["hex-samples"] as { sampleCount: number }[];

    expect(rows.reduce((total, row) => total + row.sampleCount, 0)).toBe(3);
  });

  it("keeps metric identifiers in correlation cells while showing labels", () => {
    const result = {
      metrics: ["a", "b"],
      pearson: [
        [1, 0.25],
        [0.25, 1],
      ],
      spearman: [
        [1, 0.2],
        [0.2, 1],
      ],
      pairN: [
        [10, 8],
        [8, 10],
      ],
      minPairN: 3,
    } as unknown as CorrelationResult;
    const chart = correlationChart(result, { a: "Metric A", b: "Metric B" }, false);
    const rows = chart.datasets["correlation-cells"] as { xMetric: string; yMetric: string; xLabel: string }[];

    expect(rows).toContainEqual(expect.objectContaining({ xMetric: "a", yMetric: "b", xLabel: "Metric A" }));
  });

  it("assigns overflow clusters to the shared Other colour and draws centroid rows", () => {
    const chart = clustersChart(
      [
        [0, 0],
        [1, 1],
      ],
      {
        assignments: [0, 6],
        centroids: [
          [0, 0],
          [1, 1],
        ],
        clusters: [
          { id: 0, n: 1, share: 0.5, medianX: 0, medianY: 0 },
          { id: 6, n: 1, share: 0.5, medianX: 1, medianY: 1 },
        ],
        silhouette: null,
      },
      "PC 1",
      "PC 2",
    );
    const rows = chart.datasets["cluster-points"] as { cluster: string }[];

    expect(rows[1].cluster).toBe("Other");
    expect(chart.datasets["cluster-centroids"]).toHaveLength(2);
  });
});
