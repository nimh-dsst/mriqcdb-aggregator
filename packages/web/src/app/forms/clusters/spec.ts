
import type { TopLevelSpec } from "vega-lite";



import { continuousAxisSpec } from '../shared/continuous-axis';
import type { MetricAxis } from '../histogram/histogram';
import { baseConfig, FILLS_CONTAINER, LIGHT_THEME, OTHER_COLOR, valueScale, type ChartTheme, VL_SCHEMA } from "../shared/palette";


import type { ClusterPoint, AnalysisClustering, AnalysisChartResult } from '../heatmap/analysis-charts';
const chartConfig = (theme: ChartTheme) => baseConfig(theme);
const epochDate = (days: number) => Date.UTC(2000, 0, 1) + days * 86400000;

function normalizePoint(point: ClusterPoint | readonly [number, number]): ClusterPoint {
  return "x" in point ? point : { x: point[0], y: point[1] };
}

function clustersChartData(
  points: readonly (ClusterPoint | readonly [number, number])[],
  clustering: AnalysisClustering,
  xLabel: string,
  yLabel: string,
  theme: ChartTheme = LIGHT_THEME,
  scales: { x?: Record<string, unknown>; y?: Record<string, unknown> } = {},
): AnalysisChartResult {
  const clusterById = new Map(clustering.clusters.map((cluster) => [cluster.id, cluster]));
  const displayCluster = (id: number) => (id < 0 || id >= 6 ? "Other" : `Cluster ${id + 1}`);
  const colorFor = (id: number) =>
    id < 0 || id >= 6 ? OTHER_COLOR : theme.categories[id] ?? OTHER_COLOR;
  const rows = points.map((rawPoint, index) => {
    const point = normalizePoint(rawPoint);
    const clusterId = clustering.assignments[index] ?? -1;
    const cluster = clusterById.get(clusterId);
    return {
      x: point.x,
      y: point.y,
      clusterId,
      cluster: displayCluster(clusterId),
      color: colorFor(clusterId),
      clusterN: cluster?.n ?? 0,
      clusterShare: cluster?.share ?? 0,
    };
  });
  const centroids = clustering.centroids.map(([x, y], index) => {
    const cluster = clustering.clusters[index] ?? clustering.clusters.find((item) => item.id === index);
    const clusterId = cluster?.id ?? index;
    return {
      x,
      y,
      clusterId,
      cluster: displayCluster(clusterId),
      color: colorFor(clusterId),
      clusterN: cluster?.n ?? 0,
      clusterShare: cluster?.share ?? 0,
    };
  });
  const clusterNames = [...new Set(rows.map((row) => row.cluster))];
  const clusterColors = clusterNames.map((name) =>
    name === "Other" ? OTHER_COLOR : theme.categories[Number(name.slice(8)) - 1] ?? OTHER_COLOR,
  );

  return {
    datasets: { "cluster-points": rows, "cluster-centroids": centroids },
    spec: {
      $schema: VL_SCHEMA,
      ...FILLS_CONTAINER,
      layer: [
        {
          data: { name: "cluster-points" },
          mark: { type: "point", filled: true, size: 20, opacity: 0.65 },
          encoding: {
            x: { field: "x", type: "quantitative", axis: { title: xLabel, grid: false }, scale: scales.x },
            y: { field: "y", type: "quantitative", axis: { title: yLabel, grid: false }, scale: scales.y },
            color: { field: "cluster", type: "nominal", scale: { domain: clusterNames, range: clusterColors } },
            tooltip: [
              { field: "cluster", type: "nominal", title: "Cluster" },
              { field: "clusterN", type: "quantitative", title: "Cluster size" },
              { field: "clusterShare", type: "quantitative", title: "Cluster share", format: ".1%" },
              { field: "x", type: "quantitative", title: xLabel },
              { field: "y", type: "quantitative", title: yLabel },
            ],
          },
        },
        {
          data: { name: "cluster-centroids" },
          mark: { type: "point", filled: true, fill: theme.surface, stroke: theme.labelInk, size: 130, strokeWidth: 2.5 },
          encoding: {
            x: { field: "x", type: "quantitative", scale: scales.x },
            y: { field: "y", type: "quantitative", scale: scales.y },
            tooltip: [
              { field: "cluster", type: "nominal", title: "Centroid" },
              { field: "clusterN", type: "quantitative", title: "Cluster size" },
              { field: "clusterShare", type: "quantitative", title: "Cluster share", format: ".1%" },
              { field: "x", type: "quantitative", title: xLabel },
              { field: "y", type: "quantitative", title: yLabel },
            ],
          },
        },
      ],
      ...chartConfig(theme),
    } as unknown as TopLevelSpec,
  };
}

export function clustersChart(points: Parameters<typeof clustersChartData>[0], clustering: AnalysisClustering,
  xLabel: string, yLabel: string, theme: ChartTheme = LIGHT_THEME, xScale: MetricAxis['xScale'] = 'linear',
  options: { xRange?: 'auto' | readonly [number, number]; yRange?: 'auto' | readonly [number, number]; yScale?: 'linear' | 'log' | 'symlog' } = {}): AnalysisChartResult {
  const scales = { x: valueScale(xScale ?? 'linear', options.xRange ?? 'auto'), y: valueScale(options.yScale ?? 'linear', options.yRange ?? 'auto') };
  if (xScale !== 'time') return clustersChartData(points, clustering, xLabel, yLabel, theme, scales);
  if (options.xRange && options.xRange !== 'auto') scales.x = { ...scales.x, domain: options.xRange.map(epochDate) };
  const chart = clustersChartData(points.map(point => { const p = normalizePoint(point); return { x: epochDate(p.x), y: p.y }; }),
    { ...clustering, centroids: clustering.centroids.map(([x, y]) => [epochDate(x), y]) }, xLabel, yLabel, theme, scales);
  return { ...chart, spec: continuousAxisSpec(chart.spec, { label: xLabel, xScale: 'time', logScale: false, countTitle: 'Scans' }) };
}
