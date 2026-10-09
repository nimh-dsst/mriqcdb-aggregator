import type { CorrelationResult, Density2dResult } from "@mriqc/shared";
import type { TopLevelSpec } from "vega-lite";

import { massContours } from "./analysis-math";
import { correlationOrder } from "./correlation-order";
import { continuousAxisSpec } from './continuous-axis';
import type { MetricAxis } from './histogram';
import {
  baseConfig,
  batlowRange,
  countRange,
  FILLS_CONTAINER,
  LIGHT_THEME,
  OTHER_COLOR,
  valueScale,
  type ChartTheme,
  VL_SCHEMA,
} from "./palette";

/** A named cohort rendered by the distribution comparison charts. */
export interface AnalysisSeries {
  id: string;
  name: string;
  color: string;
  result: Density2dResult;
}

export interface ClusterPoint {
  x: number;
  y: number;
}

export interface AnalysisClustering {
  assignments: number[];
  centroids: [number, number][];
  clusters: {
    id: number;
    n: number;
    share: number;
    medianX: number;
    medianY: number;
  }[];
  silhouette: number | null;
}

export interface AnalysisChartResult {
  spec: TopLevelSpec;
  datasets: Record<string, readonly unknown[]>;
}

type DensityShape = {
  x: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  y: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  counts: number[];
  n: number;
  pearson: number | null;
  spearman: number | null;
  sample: [number, number][];
};

type CorrelationShape = {
  metrics: string[];
  pearson?: number[][];
  spearman?: number[][];
  pairN: number[][];
  minPairN: number;
};

type DensityGridRow = {
  series: string;
  seriesId: string;
  x: number;
  x2: number;
  y: number;
  y2: number;
  count: number;
  logCount: number | null;
};

type PointRow = { series: string; seriesId: string; x: number; y: number };

type ContourRow = {
  series: string;
  seriesId: string;
  color: string;
  mass: number;
  path: number;
  order: number;
  x: number;
  y: number;
};

type HexRow = {
  series: string;
  seriesId: string;
  x: number;
  y: number;
  sampleCount: number;
};

const HEXAGON_PATH = "M0,-1L0.866,-0.5L0.866,0.5L0,1L-0.866,0.5L-0.866,-0.5Z";
const asDensity = (result: Density2dResult): DensityShape => result as unknown as DensityShape;
const asCorrelation = (result: CorrelationResult): CorrelationShape => result as unknown as CorrelationShape;

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const gridBounds = (result: DensityShape) => ({
  x: [finite(result.x.lo), finite(result.x.lo + result.x.width * result.x.bins)] as [number, number],
  y: [finite(result.y.lo), finite(result.y.lo + result.y.width * result.y.bins)] as [number, number],
});

const chartConfig = (theme: ChartTheme) => baseConfig(theme);

function gridRows(series: AnalysisSeries): DensityGridRow[] {
  const result = asDensity(series.result);
  const rows: DensityGridRow[] = [];
  const xBins = Number.isFinite(result.x.bins) ? Math.max(0, Math.floor(result.x.bins)) : 0;
  const yBins = Number.isFinite(result.y.bins) ? Math.max(0, Math.floor(result.y.bins)) : 0;
  const xLo = finite(result.x.lo);
  const yLo = finite(result.y.lo);
  const xWidth = finite(result.x.width);
  const yWidth = finite(result.y.width);

  for (let yIndex = 0; yIndex < yBins; yIndex += 1) {
    for (let xIndex = 0; xIndex < xBins; xIndex += 1) {
      const count = result.counts[yIndex * xBins + xIndex] ?? 0;
      rows.push({
        series: series.name,
        seriesId: series.id,
        x: xLo + xIndex * xWidth,
        x2: xLo + (xIndex + 1) * xWidth,
        y: yLo + yIndex * yWidth,
        y2: yLo + (yIndex + 1) * yWidth,
        count: Math.max(0, finite(count)),
        logCount: count > 0 && Number.isFinite(count) ? count : null,
      });
    }
  }
  return rows;
}

function sampleRows(series: readonly AnalysisSeries[]): PointRow[] {
  return series.flatMap((item) =>
    asDensity(item.result).sample
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .map(([x, y]) => ({ series: item.name, seriesId: item.id, x, y })),
  );
}

function contourRows(series: readonly AnalysisSeries[]): ContourRow[] {
  return series.flatMap((item) =>
    massContours(item.result).map((contour) => ({
      series: item.name,
      seriesId: item.id,
      color: item.color,
      mass: contour.mass,
      path: contour.path,
      order: contour.order,
      x: contour.x,
      y: contour.y,
    })),
  );
}

function extent(series: readonly AnalysisSeries[], axis: "x" | "y"): [number, number] {
  const fromGrids = series.flatMap((item) => gridBounds(asDensity(item.result))[axis]);
  const values = fromGrids.filter(Number.isFinite);
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi];
}

/** Aggregate retained samples into a pointy-top hexagonal lattice in data space. */
function hexRows(series: readonly AnalysisSeries[], cells = 60): HexRow[] {
  const xExtent = extent(series, "x");
  const yExtent = extent(series, "y");
  const xRadius = Math.max((xExtent[1] - xExtent[0]) / (1.5 * cells), Number.EPSILON);
  const yRadius = Math.max((yExtent[1] - yExtent[0]) / (Math.sqrt(3) * cells), Number.EPSILON);
  const buckets = new Map<string, HexRow>();

  for (const point of sampleRows(series)) {
    const q = Math.round((point.x - xExtent[0]) / (1.5 * xRadius));
    const r = Math.round(
      ((point.y - yExtent[0]) / yRadius - (Math.abs(q) % 2) * Math.sqrt(3) / 2) / Math.sqrt(3),
    );
    const key = `${point.seriesId}:${q}:${r}`;
    const current = buckets.get(key);
    if (current) {
      current.sampleCount += 1;
      continue;
    }
    buckets.set(key, {
      series: point.series,
      seriesId: point.seriesId,
      x: xExtent[0] + q * 1.5 * xRadius,
      y: yExtent[0] + (r * Math.sqrt(3) + (Math.abs(q) % 2) * Math.sqrt(3) / 2) * yRadius,
      sampleCount: 1,
    });
  }
  return [...buckets.values()];
}

function axisEncoding(
  field: "x" | "y",
  title: string,
  domain: [number, number],
): Record<string, unknown> {
  return {
    field,
    type: "quantitative",
    scale: { domain, nice: false, zero: false },
    axis: { title, grid: false, labelColor: undefined },
  };
}

function densityChartData(
  series: readonly AnalysisSeries[],
  opts: {
    xLabel: string;
    yLabel: string;
    xScale?: Record<string, unknown>;
    yScale?: Record<string, unknown>;
    colorScale?: 'linear' | 'log' | 'sqrt';
    colorDomain?: 'auto' | readonly [number, number];
    cells?: number;
    form: "heatmap" | "scatter" | "hexbin";
    showPoints: boolean;
    theme?: ChartTheme;
    brush?: { x: [number, number]; y: [number, number] } | null;
    brushEnabled?: boolean;
  },
): AnalysisChartResult {
  const theme = opts.theme ?? LIGHT_THEME;
  const xDomain = extent(series, "x");
  const yDomain = extent(series, "y");
  const grid = series.length > 0 ? gridRows(series[0]) : [];
  const allGrid = series.flatMap(gridRows);
  const points = sampleRows(series);
  const contours = series.length > 1 ? contourRows(series) : [];
  const hexagons = hexRows(series, opts.cells);
  const colorType = opts.colorScale ?? 'log';
  const colorScale = { type: colorType, range: countRange(8, theme), clamp: true,
    ...(opts.colorDomain && opts.colorDomain !== 'auto' ? { domain: [...opts.colorDomain] } : colorType === 'log' ? { domainMin: 1 } : { zero: true }) };
  const colors = series.map((item) => item.color);
  const brush = opts.brush
    ? {
        name: "brush2d",
        select: { type: "interval", encodings: ["x", "y"] },
        value: { x: opts.brush.x, y: opts.brush.y },
      }
    : { name: "brush2d", select: { type: "interval", encodings: ["x", "y"] } };
  const params = opts.brushEnabled === false ? [] : [brush];

  const x = axisEncoding("x", opts.xLabel, xDomain);
  const y = axisEncoding("y", opts.yLabel, yDomain);
  Object.assign(x['scale'] as object, opts.xScale);
  Object.assign(y['scale'] as object, opts.yScale);
  const pointLayer = {
    data: { name: "density-samples" },
    mark: { type: "point", filled: true, size: 4, opacity: 0.5, color: theme.labelInk, clip: true },
    encoding: {
      x,
      y,
      tooltip: [
        { field: "series", type: "nominal", title: "Cohort" },
        { field: "x", type: "quantitative", title: opts.xLabel },
        { field: "y", type: "quantitative", title: opts.yLabel },
      ],
    },
  };

  if (opts.form === "scatter") {
    return {
      datasets: { "density-samples": points },
      spec: {
        $schema: VL_SCHEMA,
        ...FILLS_CONTAINER,
        params,
        data: { name: "density-samples" },
        mark: pointLayer.mark,
        encoding: pointLayer.encoding,
        ...chartConfig(theme),
      } as unknown as TopLevelSpec,
    };
  }

  if (opts.form === "hexbin") {
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
        ...chartConfig(theme),
      } as unknown as TopLevelSpec,
    };
  }

  const densityEncoding = {
    x: { ...x, field: "x" },
    x2: { field: "x2" },
    y: { ...y, field: "y" },
    y2: { field: "y2" },
    color: {
      field: colorType === 'log' ? 'logCount' : 'count',
      type: "quantitative",
      title: `Count (${colorType})`,
      scale: colorScale,
      // The colour bar runs the chart's height instead of a fixed stub.
      legend: { gradientLength: { expr: "max(60, height - 40)" } },
    },
    tooltip: [
      { field: "count", type: "quantitative", title: "Count" },
      { field: "x", type: "quantitative", title: `${opts.xLabel} lower` },
      { field: "x2", type: "quantitative", title: `${opts.xLabel} upper` },
      { field: "y", type: "quantitative", title: `${opts.yLabel} lower` },
      { field: "y2", type: "quantitative", title: `${opts.yLabel} upper` },
    ],
  };
  const contourLayer = {
    data: { name: "density-contours" },
    mark: { type: "line", strokeWidth: 1.5, clip: true },
    encoding: {
      x,
      y,
      detail: [
        { field: "seriesId", type: "nominal" },
        { field: "mass", type: "nominal" },
        { field: "path", type: "nominal" },
      ],
      order: { field: "order", type: "quantitative" },
      color: {
        field: "seriesId",
        type: "nominal",
        scale: { domain: series.map((item) => item.id), range: colors },
        legend: null,
      },
      strokeDash: {
        field: "mass",
        type: "nominal",
        scale: { domain: [0.25, 0.5, 0.75], range: [[1, 0], [4, 2], [2, 2]] },
        legend: { title: "Enclosed mass" },
      },
    },
  };

  // Any split gets small multiples: overlaid contours of sparse groups are
  // unreadable, side-by-side heatmaps are not.
  if (series.length > 1) {
    const panelRows = [
      ...allGrid.map((row) => ({ ...row, kind: "grid" })),
      ...contours.map((row) => ({ ...row, kind: "contour" })),
      ...points.map((row) => ({ ...row, kind: "point" })),
    ];
    return {
      datasets: {
        "density-grid": allGrid,
        "density-samples": points,
        "density-contours": contours,
        "density-panels": panelRows,
      },
      spec: {
        $schema: VL_SCHEMA,
        data: { name: "density-panels" },
        facet: { field: "seriesId", type: "nominal", sort: series.map((item) => item.id), title: null,
          header: { labelExpr: `(${JSON.stringify(Object.fromEntries(series.map(item => [item.id,item.name])))})[datum.value]` } },
        columns: 2,
        usermeta: { facets: series.length },
        spec: {
          width: 260,
          height: 170,
          // One shared colour scale and no contours: small multiples are read
          // against each other, and contours on a few dozen scans are squiggles.
          layer: [
            {
              params,
              transform: [{ filter: "datum.kind === 'grid'" }],
              mark: { type: "rect", clip: true },
              // The one colour bar runs the height of the whole grid of plots.
              encoding: { ...densityEncoding, color: { ...densityEncoding.color,
                legend: { gradientLength: { expr: `max(60, ${Math.ceil(series.length / 2)} * (child_height + 40) - 60)` } } } },
            },
          ],
        },
        ...chartConfig(theme),
      } as unknown as TopLevelSpec,
    };
  }

  return {
    datasets: { "density-grid": grid, "density-samples": points, "density-contours": contours },
    spec: {
      $schema: VL_SCHEMA,
      ...FILLS_CONTAINER,
      layer: [
        // One interaction owner: inheriting the interval in every overlay layer
        // produces duplicate brush2d signals when Vega parses the compiled spec.
        { params, data: { name: "density-grid" }, mark: { type: "rect", clip: true }, encoding: densityEncoding },
        ...(series.length > 1 ? [contourLayer] : []),
        ...(opts.showPoints ? [pointLayer] : []),
      ],
      resolve: { scale: { color: 'independent' } },
      ...chartConfig(theme),
    } as unknown as TopLevelSpec,
  };
}

const epochDate = (days: number) => Date.UTC(2000, 0, 1) + days * 86400000;

export function densityChart(series: readonly AnalysisSeries[], opts: Parameters<typeof densityChartData>[1]): AnalysisChartResult {
  if (opts.xScale?.['type'] !== 'utc') return densityChartData(series, opts);
  const dated = series.map(item => ({ ...item, result: { ...item.result,
    x: { ...item.result.x, lo: epochDate(item.result.x.lo), width: item.result.x.width * 86400000 },
    sample: item.result.sample.map(([x, y]) => [epochDate(x), y] as [number, number]),
  } }));
  const chart = densityChartData(dated, { ...opts, brushEnabled: false,
    xScale: { ...opts.xScale, ...(Array.isArray(opts.xScale['domain']) ? { domain: opts.xScale['domain'].map(epochDate) } : {}) } });
  return { ...chart, spec: continuousAxisSpec(chart.spec, { label: opts.xLabel, xScale: 'time', logScale: false, countTitle: 'Scans' }) };
}

type CorrelationRow = {
  xMetric: string;
  yMetric: string;
  xLabel: string;
  yLabel: string;
  xAxisLabel: string;
  yAxisLabel: string;
  pearson: number | null;
  spearman: number | null;
  n: number;
  value: number | null;
  label: string;
  textColor: string;
  metricCount: number;
};

const matrixValue = (matrix: number[][] | undefined, row: number, column: number): number | null => {
  const value = matrix?.[row]?.[column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const VIK_11 = [
  "#001261",
  "#023a7b",
  "#116496",
  "#5496b7",
  "#a7c9da",
  "#ece5e0",
  "#e1b8a0",
  "#cd8961",
  "#b75a26",
  "#852206",
  "#590008",
];

/** Keep long metric names readable without abbreviating the axis vocabulary. */
function wrapCorrelationLabel(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return value;
  const breakAt = Math.ceil(words.length / 2);
  return `${words.slice(0, breakAt).join(" ")}\n${words.slice(breakAt).join(" ")}`;
}

export function correlationChart(
  result: CorrelationResult,
  labels: Readonly<Record<string, string>>,
  order: boolean,
  theme: ChartTheme = LIGHT_THEME,
  coefficient: "spearman" | "pearson" = "spearman",
  colorOptions: { colorScale?: 'linear' | 'log' | 'sqrt'; colorDomain?: 'auto' | readonly [number, number] } = {},
): AnalysisChartResult {
  const correlation = asCorrelation(result);
  const source = correlation[coefficient] ?? [];
  const indices = order && source.length > 0 ? correlationOrder(source) : correlation.metrics.map((_, index) => index);
  const metrics = indices.map((index) => correlation.metrics[index]);
  const rows: CorrelationRow[] = [];

  for (const yIndex of indices) {
    for (const xIndex of indices) {
      if (indices.indexOf(yIndex) <= indices.indexOf(xIndex)) continue;
      const pearson = matrixValue(correlation.pearson, yIndex, xIndex);
      const spearman = matrixValue(correlation.spearman, yIndex, xIndex);
      const value = matrixValue(source, yIndex, xIndex);
      const xLabel = labels[correlation.metrics[xIndex]] ?? correlation.metrics[xIndex];
      const yLabel = labels[correlation.metrics[yIndex]] ?? correlation.metrics[yIndex];
      rows.push({
        xMetric: correlation.metrics[xIndex],
        yMetric: correlation.metrics[yIndex],
        xLabel,
        yLabel,
        xAxisLabel: wrapCorrelationLabel(xLabel),
        yAxisLabel: wrapCorrelationLabel(yLabel),
        pearson,
        spearman,
        n: matrixValue(correlation.pairN, yIndex, xIndex) ?? 0,
        value,
        label: value === null ? "—" : value.toFixed(2),
        textColor: value !== null && Math.abs(value) >= 0.5 ? "#ffffff" : theme.labelInk,
        metricCount: metrics.length,
      });
    }
  }

  const labelDomain = metrics.map((metric) => wrapCorrelationLabel(labels[metric] ?? metric));
  const coefficientTitle = coefficient === "spearman" ? "Spearman ρ" : "Pearson r";
  const colorType = colorOptions.colorScale ?? 'linear';
  const domain = colorOptions.colorDomain && colorOptions.colorDomain !== 'auto' ? colorOptions.colorDomain : colorType === 'log' ? [0.001, 1] : [-1, 1];
  const colorDomain = VIK_11.map((_, i) => colorType === 'log'
    ? Math.exp(Math.log(Math.max(Number.MIN_VALUE, domain[0])) + i / 10 * (Math.log(domain[1]) - Math.log(Math.max(Number.MIN_VALUE, domain[0]))))
    : domain[0] + (domain[1] - domain[0]) * i / 10);
  const matrixScale = { domain: labelDomain, paddingInner: 0, paddingOuter: 0,
    range: [0, { expr: "min(width, height)" }] };
  return {
    datasets: { "correlation-cells": rows },
    spec: {
      $schema: VL_SCHEMA,
      ...FILLS_CONTAINER,
      data: { name: "correlation-cells" },
      layer: [
        {
          mark: { type: "rect" },
          encoding: {
            x: { field: "xAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain, axis: { title: null, labelAngle: -40, labelExpr: "split(datum.label, '\\n')", labelLineHeight: 13, labelOverlap: false, labelLimit: 0, grid: false } },
            y: { field: "yAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain, axis: { title: null, labelExpr: "split(datum.label, '\\n')", labelLineHeight: 13, labelOverlap: false, labelLimit: 0, grid: false } },
            color: {
              field: "value",
              type: "quantitative",
              title: `${coefficientTitle} (${colorType})`,
              legend: { orient: "right" },
              scale: {
                type: colorType,
                domain: colorDomain,
                range: VIK_11,
                clamp: true,
              },
            },
            tooltip: [
              { field: "xLabel", type: "nominal", title: "Metric x" },
              { field: "yLabel", type: "nominal", title: "Metric y" },
              { field: "value", type: "quantitative", title: coefficientTitle, format: ".3f" },
              { field: "n", type: "quantitative", title: "Paired observations" },
            ],
          },
        },
        {
          mark: { type: "text", baseline: "middle", fontSize: 12 },
          encoding: {
            x: { field: "xAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain },
            y: { field: "yAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain },
            text: { field: "label", type: "nominal" },
            color: { value: { expr: "datum.textColor" } },
          },
        },
      ],
      ...chartConfig(theme),
    } as unknown as TopLevelSpec,
  };
}

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
