import { scatterSpec } from '../scatter/spec';
import { hexbinSpec } from '../hexbin/spec';
import type { CorrelationResult, Density2dResult } from "@mriqc/shared";
import type { TopLevelSpec } from "vega-lite";

import { massContours } from "./analysis-math";
import { correlationOrder } from "../matrix/correlation-order";
import { continuousAxisSpec } from '../shared/continuous-axis';
import type { MetricAxis } from '../histogram/histogram';
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
} from "../shared/palette";

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

  if (opts.form === "scatter") return scatterSpec({ points, params, pointLayer, theme });

  if (opts.form === "hexbin") return hexbinSpec({ hexagons, params, opts, x, y, colorType, colorScale, theme });

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

export { correlationChart } from '../matrix/spec';
export { clustersChart } from '../clusters/spec';
