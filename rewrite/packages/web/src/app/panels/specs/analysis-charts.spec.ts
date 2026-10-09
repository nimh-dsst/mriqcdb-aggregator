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
    const spec = chart.spec as unknown as { params: { name: string; select: { encodings: string[] } }[] };

    expect(chart.datasets["density-grid"]).toHaveLength(4);
    expect(spec.params[0]).toEqual({ name: "brush2d", select: { type: "interval", encodings: ["x", "y"] } });
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
