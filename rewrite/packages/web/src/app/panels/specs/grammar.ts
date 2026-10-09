import type { TopLevelSpec } from "vega-lite";

import { continuousX } from "./continuous-axis";
import type { MetricAxis } from "./histogram";
import { baseConfig, FILLS_CONTAINER, VL_SCHEMA } from "./palette";

const MRIQC_EPOCH_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

export type ChartDatasets = Record<string, readonly unknown[]>;

export type ChartResult = {
  spec: TopLevelSpec;
  datasets: ChartDatasets;
  degenerateNote?: string;
};

export type BinnedSummaryBucket = {
  lo: number;
  hi: number;
  start?: string;
  group: string | number | boolean | null;
  cohort?: string;
  n: number;
  isOther: boolean;
  quantiles: {
    p05: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  mean: number;
  thin: boolean;
  /** Optional server-provided aggregates. */
  sum?: number;
  min?: number;
  max?: number;
};

export type BinnedSummaryResult = {
  xKind: "metric" | "time";
  yKind: "metric" | "time";
  range: readonly [number, number];
  buckets: readonly BinnedSummaryBucket[];
};

/** Counts are already expressed in the x-axis unit (milliseconds for time). */
export type BinSeries = {
  id: string;
  name: string;
  color: string;
  bins: readonly {
    lo: number;
    hi: number;
    count: number;
  }[];
};

export type SummaryAggregate =
  | "median"
  | "mean"
  | "p05"
  | "p25"
  | "p50"
  | "p75"
  | "p95"
  | "sum"
  | "min"
  | "max";

export type SummaryForm =
  | "histogram"
  | "line"
  | "area"
  | "density"
  | "ecdf"
  | "box";

export type BandForm = "band" | "lines";
export type BandQuantiles = "quartiles" | "tails";

type SummaryRow = {
  x: number;
  x2: number;
  center: number;
  group: string | number | boolean | null;
  cohort?: string;
  n: number;
  value: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
};

type CountBandRow = {
  x: number;
  x2: number;
  center: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
};

type CountBandLineRow = {
  center: number;
  quantile: "p05" | "p25" | "p50" | "p75" | "p95";
  value: number;
};

type CountBoxRow = {
  series: string;
  seriesId: string;
  color: string;
  count: number;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function summaryValue(
  bucket: BinnedSummaryBucket,
  aggregate: SummaryAggregate,
): number | undefined {
  switch (aggregate) {
    case "median":
    case "p50":
      return bucket.quantiles.p50;
    case "p05":
    case "p25":
    case "p75":
    case "p95":
      return bucket.quantiles[aggregate];
    case "mean":
      return bucket.mean;
    case "sum":
    case "min":
    case "max":
      return bucket[aggregate];
  }
}

/**
 * An aggregate can be drawn only when every returned bucket supplies a finite
 * value. In particular, sum/min/max are deliberately unavailable for the
 * normal response shape, which does not promise those values.
 */
export function aggregateAvailable(
  result: BinnedSummaryResult,
  aggregate: SummaryAggregate,
): boolean {
  return (
    result.buckets.length > 0 &&
    result.buckets.every((bucket) => finite(summaryValue(bucket, aggregate)))
  );
}

function summaryAxis(axis: MetricAxis, result: BinnedSummaryResult): MetricAxis {
  if (result.xKind !== "time" || axis.xScale === "time") {
    return axis;
  }

  return { ...axis, xScale: "time" };
}

function summaryX(value: number, result: BinnedSummaryResult): number {
  return result.xKind === "time" ? MRIQC_EPOCH_MS + value * DAY_MS : value;
}

function summaryY(value: number, result: BinnedSummaryResult): number {
  return result.yKind === "time" ? MRIQC_EPOCH_MS + value * DAY_MS : value;
}

/**
 * One display row per server bucket, with time bins converted from MRIQC epoch
 * days to JavaScript epoch milliseconds. An unavailable aggregate produces no
 * rows so callers can disable it using aggregateAvailable without rendering
 * misleading partial data.
 */
export function summaryRows(
  result: BinnedSummaryResult,
  aggregate: SummaryAggregate = "median",
): readonly SummaryRow[] {
  if (!aggregateAvailable(result, aggregate)) {
    return [];
  }

  return result.buckets.map((bucket) => {
    const x = summaryX(bucket.lo, result);
    const x2 = summaryX(bucket.hi, result);
    const value = summaryValue(bucket, aggregate);

    // aggregateAvailable above proves this is a finite number.
    return {
      x,
      x2,
      center: (x + x2) / 2,
      group: bucket.group,
      cohort: bucket.cohort,
      n: bucket.n,
      value: summaryY(value as number, result),
      p05: summaryY(bucket.quantiles.p05, result),
      p25: summaryY(bucket.quantiles.p25, result),
      p50: summaryY(bucket.quantiles.p50, result),
      p75: summaryY(bucket.quantiles.p75, result),
      p95: summaryY(bucket.quantiles.p95, result),
    };
  });
}

/** Smooths the selected aggregate at neighbouring bin positions. */
function densityRows(rows: readonly SummaryRow[]): readonly SummaryRow[] {
  const sorted = [...rows].sort((left, right) => left.center - right.center);
  if (sorted.length < 2) {
    return sorted;
  }

  const distances = sorted
    .slice(1)
    .map((row, index) => row.center - sorted[index].center)
    .filter((distance) => distance > 0)
    .sort((left, right) => left - right);
  const bandwidth = distances[Math.floor(distances.length / 2)] || 1;

  return sorted.map((target) => {
    let weightTotal = 0;
    let valueTotal = 0;
    for (const source of sorted) {
      const distance = (source.center - target.center) / bandwidth;
      const weight = Math.exp(-(distance * distance) / 2);
      weightTotal += weight;
      valueTotal += source.value * weight;
    }
    return { ...target, value: valueTotal / weightTotal };
  });
}

function ecdfRows(rows: readonly SummaryRow[]): readonly SummaryRow[] {
  let cumulative = 0;
  return [...rows]
    .sort((left, right) => left.x - right.x || left.x2 - right.x2)
    .map((row) => {
      cumulative += row.value;
      return { ...row, value: cumulative };
    });
}

function valueEncoding(field: string, title: string): Record<string, unknown> {
  return { field, type: "quantitative", title };
}

function summaryValueEncoding(
  field: string,
  title: string,
  result: BinnedSummaryResult,
): Record<string, unknown> {
  return { field, type: result.yKind === "time" ? "temporal" : "quantitative", title };
}

/**
 * Builds a chart for a numeric/time response binned along x. Histogram, line,
 * and area use the requested response aggregate. Density smooths that aggregate
 * over x, ECDF cumulatively sums it, and box spreads it by returned series.
 */
export function columnYChart(
  result: BinnedSummaryResult,
  yLabel: string,
  axis: MetricAxis,
  form: SummaryForm,
  aggregate: SummaryAggregate = "median",
): ChartResult {
  const resolvedAxis = summaryAxis(axis, result);
  const rows = summaryRows(result, aggregate);

  if (form === "box") {
    const box = rows.map((row) => ({
      ...row,
      series: row.group === null ? "All" : String(row.group),
    }));
    return {
      spec: {
        $schema: VL_SCHEMA,
        ...baseConfig(axis.theme),
        ...FILLS_CONTAINER,
        data: { name: "summaryBox" },
        mark: { type: "boxplot", extent: "min-max" },
        encoding: {
          x: { field: "series", type: "nominal", title: null },
          y: summaryValueEncoding("value", yLabel, result),
        },
      } as TopLevelSpec,
      datasets: { summaryBox: box },
    };
  }

  const data =
    form === "density" ? densityRows(rows) : form === "ecdf" ? ecdfRows(rows) : rows;
  const dataName = form === "density" ? "summaryDensity" : form === "ecdf" ? "summaryEcdf" : "summary";
  const mark =
    form === "histogram"
      ? { type: "bar" }
      : form === "area" || form === "density"
        ? { type: "area" }
        : { type: "line" };
  const xField = form === "histogram" ? "x" : "center";

  return {
    spec: {
      $schema: VL_SCHEMA,
      ...baseConfig(axis.theme),
      ...FILLS_CONTAINER,
      data: { name: dataName },
      mark,
      encoding: {
        x: continuousX(resolvedAxis, xField),
        ...(form === "histogram" ? { x2: { field: "x2" } } : {}),
        y: summaryValueEncoding(
          "value",
          form === "ecdf" ? `Cumulative ${yLabel}` : yLabel,
          result,
        ),
      },
    } as TopLevelSpec,
    datasets: { [dataName]: data },
  };
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function binKey(lo: number, hi: number): string {
  return `${lo}\u0000${hi}`;
}

/**
 * Aligns all distinct x intervals and computes cross-series quantiles. A
 * series without a returned interval contributes zero at that interval.
 */
export function countBandRows(
  series: readonly BinSeries[],
  share = false,
): readonly CountBandRow[] {
  const countsBySeries = series.map((item) => {
    const counts = new Map<string, number>();
    for (const bin of item.bins) {
      if (!finite(bin.lo) || !finite(bin.hi) || !finite(bin.count)) {
        continue;
      }
      const key = binKey(bin.lo, bin.hi);
      counts.set(key, (counts.get(key) ?? 0) + bin.count);
    }
    return counts;
  });
  const totals = countsBySeries.map((counts) =>
    [...counts.values()].reduce((sum, count) => sum + Math.max(0, count), 0),
  );
  const intervals = new Map<string, { x: number; x2: number }>();
  for (const item of series) {
    for (const bin of item.bins) {
      if (finite(bin.lo) && finite(bin.hi) && finite(bin.count)) {
        intervals.set(binKey(bin.lo, bin.hi), { x: bin.lo, x2: bin.hi });
      }
    }
  }

  return [...intervals.entries()]
    .map(([key, interval]) => {
      const values = countsBySeries.map((counts, index) => {
        const count = counts.get(key) ?? 0;
        return share && totals[index] > 0 ? count / totals[index] : share ? 0 : count;
      });
      return {
        ...interval,
        center: (interval.x + interval.x2) / 2,
        p05: quantile(values, 0.05),
        p25: quantile(values, 0.25),
        p50: quantile(values, 0.5),
        p75: quantile(values, 0.75),
        p95: quantile(values, 0.95),
      };
    })
    .sort((left, right) => left.x - right.x || left.x2 - right.x2);
}

function countBandLineRows(
  rows: readonly CountBandRow[],
  quantiles: BandQuantiles,
): readonly CountBandLineRow[] {
  const fields: readonly CountBandLineRow["quantile"][] =
    quantiles === "tails" ? ["p05", "p25", "p50", "p75", "p95"] : ["p25", "p50", "p75"];
  return rows.flatMap((row) =>
    fields.map((field) => ({ center: row.center, quantile: field, value: row[field] })),
  );
}

/**
 * Draws per-bin count (or per-series-normalized share) quantiles. With one
 * series, the median is its actual line and the result carries the UI hint
 * required to explain that no inter-series band exists.
 */
export function countBandChart(
  series: readonly BinSeries[],
  yLabel: string,
  axis: MetricAxis,
  form: BandForm = "band",
  quantiles: BandQuantiles = "quartiles",
): ChartResult {
  const rows = countBandRows(series, axis.yMode === "share");
  const dataName = "countBand";
  const x = continuousX(axis, "center");

  if (series.length <= 1) {
    return {
      spec: {
        $schema: VL_SCHEMA,
        ...baseConfig(axis.theme),
        ...FILLS_CONTAINER,
        data: { name: dataName },
        mark: { type: "line", color: series[0]?.color },
        encoding: { x, y: valueEncoding("p50", yLabel) },
      } as TopLevelSpec,
      datasets: { [dataName]: rows },
      degenerateNote: "One series: Band draws its counts as a line",
    };
  }

  if (form === "lines") {
    const lines = countBandLineRows(rows, quantiles);
    return {
      spec: {
        $schema: VL_SCHEMA,
        ...baseConfig(axis.theme),
        ...FILLS_CONTAINER,
        data: { name: "countBandLines" },
        mark: { type: "line" },
        encoding: {
          x: continuousX(axis, "center"),
          y: valueEncoding("value", yLabel),
          color: { field: "quantile", type: "nominal", title: "Quantile" },
        },
      } as TopLevelSpec,
      datasets: { countBand: rows, countBandLines: lines },
    };
  }

  const outerLayer = {
    mark: { type: "area", opacity: 0.12 },
    encoding: {
      x,
      y: valueEncoding("p05", yLabel),
      y2: { field: "p95" },
    },
  };
  const innerLayer = {
    mark: { type: "area", opacity: 0.3 },
    encoding: {
      x,
      y: valueEncoding("p25", yLabel),
      y2: { field: "p75" },
    },
  };
  const medianLayer = {
    mark: { type: "line" },
    encoding: { x, y: valueEncoding("p50", yLabel) },
  };

  return {
    spec: {
      $schema: VL_SCHEMA,
      ...baseConfig(axis.theme),
      ...FILLS_CONTAINER,
      data: { name: dataName },
      layer: quantiles === "tails" ? [outerLayer, innerLayer, medianLayer] : [innerLayer, medianLayer],
    } as TopLevelSpec,
    datasets: { [dataName]: rows },
  };
}

/** Each input bin is a count observation; x is nominal series and y is count. */
export function countBoxRows(series: readonly BinSeries[]): readonly CountBoxRow[] {
  return series.flatMap((item) =>
    item.bins
      .filter((bin) => finite(bin.count))
      .map((bin) => ({
        series: item.name,
        seriesId: item.id,
        color: item.color,
        count: bin.count,
      })),
  );
}

export function countBoxChart(
  series: readonly BinSeries[],
  yLabel: string,
  axis?: MetricAxis,
): ChartResult {
  const rows = countBoxRows(series);
  return {
    spec: {
      $schema: VL_SCHEMA,
      ...baseConfig(axis?.theme),
      ...FILLS_CONTAINER,
      data: { name: "countBox" },
      mark: { type: "boxplot", extent: "min-max" },
      encoding: {
        x: { field: "seriesId", type: "nominal", title: null },
        y: valueEncoding("count", yLabel),
        color: { field: "color", type: "nominal", scale: null, legend: null },
        tooltip: [
          { field: "series", type: "nominal", title: "Series" },
          { field: "count", type: "quantitative", title: yLabel },
        ],
      },
    } as TopLevelSpec,
    datasets: { countBox: rows },
  };
}
