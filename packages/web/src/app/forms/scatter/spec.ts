import type { TopLevelSpec } from 'vega-lite';
import { VL_SCHEMA, FILLS_CONTAINER, baseConfig, type ChartTheme } from '../shared/palette';
import type { AnalysisChartResult } from '../heatmap/analysis-charts';
export function scatterSpec({ points, params, pointLayer, theme }: {
  points: readonly unknown[]; params: unknown;
  pointLayer: { mark: unknown; encoding: unknown }; theme: ChartTheme;
}): AnalysisChartResult {
    return {
      datasets: { "density-samples": points },
      spec: {
        $schema: VL_SCHEMA,
        ...FILLS_CONTAINER,
        params,
        data: { name: "density-samples" },
        mark: pointLayer.mark,
        encoding: pointLayer.encoding,
        ...baseConfig(theme),
      } as unknown as TopLevelSpec,
    };
}
