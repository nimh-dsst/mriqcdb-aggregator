import type { TopLevelSpec } from 'vega-lite';
import { VL_SCHEMA, FILLS_CONTAINER, baseConfig, type ChartTheme } from '../shared/palette';
import type { AnalysisChartResult } from '../heatmap/analysis-charts';
const HEXAGON_PATH = "M0,-1L0.866,-0.5L0.866,0.5L0,1L-0.866,0.5L-0.866,-0.5Z";
export function hexbinSpec({ hexagons, params, opts, x, y, colorType, colorScale, theme }: {
  hexagons: readonly unknown[]; params: unknown; opts: { cells?: number; xLabel: string; yLabel: string };
  x: unknown; y: unknown; colorType: string; colorScale: unknown; theme: ChartTheme;
}): AnalysisChartResult {
    return {
      datasets: { "hex-samples": hexagons },
      spec: {
        $schema: VL_SCHEMA,
        ...FILLS_CONTAINER,
        params,
        data: { name: "hex-samples" },
        mark: { type: "point", filled: true, shape: HEXAGON_PATH, size: { expr: `pow(min(width, height) / ${opts.cells ?? 60}, 2) * 2` }, opacity: 0.85, clip: true },
        encoding: {
          x,
          y,
          color: {
            field: "sampleCount",
            type: "quantitative",
            title: `Count (${colorType})`,
            scale: colorScale,
          },
          tooltip: [
            { field: "series", type: "nominal", title: "Cohort" },
            { field: "sampleCount", type: "quantitative", title: "Sample count (hex bin)" },
            { field: "x", type: "quantitative", title: opts.xLabel },
            { field: "y", type: "quantitative", title: opts.yLabel },
          ],
        },
        title: { text: "Retained sample points, hex-binned" },
        ...baseConfig(theme),
      } as unknown as TopLevelSpec,
    };
}
