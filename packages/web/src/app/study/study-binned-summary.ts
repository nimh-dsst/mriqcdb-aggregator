import {
  asColumnId,
  binnedSummaryFragments,
  continuousAxisExpr,
  getAuthoredCatalog,
  quoteIdent,
  type BinnedSummaryQuery,
  type BinnedSummaryResult,
  type Granularity,
} from "@mriqc/shared";

import {
  compileStudyStatement,
  metricExpression,
  predicate,
  type StudyRow,
} from "./study-sql";

const MAX_GROUPS = 50;
const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

type AxisKind = "metric" | "time";

export interface BinnedSummaryStatements {
  stats: ReturnType<typeof compileStudyStatement>;
  buckets: (range: [number, number]) => ReturnType<typeof compileStudyStatement>;
}

function axisKind(query: BinnedSummaryQuery): AxisKind {
  return query.x === "created_at" ? "time" : "metric";
}

function numericBins(bins: number | Granularity): number {
  if (typeof bins !== "number" || !Number.isInteger(bins) || bins < 1 || bins > 200) {
    throw new Error("Metric binned summaries require 1 to 200 bins");
  }
  return bins;
}

function timeGranularity(bins: number | Granularity): Granularity {
  if (typeof bins === "number") {
    throw new Error("Time binned summaries require a calendar granularity");
  }
  return bins;
}

function groupHoles(
  query: BinnedSummaryQuery,
  columns: ReadonlySet<string>,
  kind: AxisKind,
): {
  group_expr: string;
  group_numeric: string;
  group_bins: string;
  max_groups: string;
} {
  const groupBins = 10;
  if (!query.groups) {
    return {
      group_expr: "NULL",
      group_numeric: "FALSE",
      group_bins: String(groupBins),
      max_groups: String(MAX_GROUPS),
    };
  }

  const group = String(query.groups);
  if (!columns.has(group)) {
    throw new Error(`Grouping column ${group} is not available in this study`);
  }

  const field = getAuthoredCatalog().fields.find((candidate) => candidate.id === query.groups);
  if (!field || !field.groupable) {
    throw new Error(`Column ${group} cannot be used to group a binned summary`);
  }
  if (!field.modalities.includes(query.modality)) {
    throw new Error(`Column ${group} is not available for modality ${query.modality}`);
  }

  return {
    group_expr: quoteIdent(group),
    group_numeric: field.kind === "numeric" ? "TRUE" : "FALSE",
    group_bins: String(groupBins),
    max_groups: String(MAX_GROUPS),
  };
}

export function compileStudyBinnedSummary(
  query: BinnedSummaryQuery,
  columns: ReadonlySet<string>,
): BinnedSummaryStatements {
  if (query.cohorts?.length) {
    throw new Error("Binned summary cohorts must be compiled by the study runner");
  }

  const kind = axisKind(query);
  if (kind === "time") {
    if (!columns.has("created_at")) {
      throw new Error("Time binned summaries require a created_at column");
    }
    timeGranularity(query.bins);
  } else {
    numericBins(query.bins);
  }

  const { where, params } = predicate(query, columns);
  const x = kind === "time"
    ? continuousAxisExpr(asColumnId("created_at"), "time")
    : metricExpression(query.modality, query.x, columns);
  if (query.y === "created_at" && !columns.has("created_at")) {
    throw new Error("Time binned summaries require a created_at column");
  }
  const y = query.y === "created_at"
    ? continuousAxisExpr(asColumnId("created_at"), "time")
    : metricExpression(query.modality, query.y, columns);
  const baseHoles = {
    table: quoteIdent("study"),
    where,
    x,
    y,
  };
  const stats = compileStudyStatement("binned_summary", "stats", baseHoles, params);
  const group = groupHoles(query, columns, kind);
  const fragments = binnedSummaryFragments(query.bins);

  return {
    stats,
    buckets(range) {
      if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
        throw new Error("Binned summary ranges must contain finite values");
      }

      return compileStudyStatement(
        "binned_summary",
        "buckets",
        { ...baseHoles, ...group, ...fragments },
        [...params, range[0], range[1], kind === "metric" ? numericBins(query.bins) : 1],
      );
    },
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}

function requiredNumber(value: unknown, field: string): number {
  const result = optionalNumber(value);
  if (result === undefined) {
    throw new Error(`Binned summary returned an invalid ${field}`);
  }
  return result;
}

function valuesOf(value: unknown): unknown[] {
  if (value === null || value === undefined || typeof value === "string") {
    return [];
  }
  if (typeof value === "object" && Symbol.iterator in value) {
    return Array.from(value as Iterable<unknown>);
  }
  return [];
}

function rowQuantiles(row: StudyRow): { p05: number; p25: number; p50: number; p75: number; p95: number } {
  const quantiles = valuesOf(row["qs"]);
  if (quantiles.length !== 5) {
    throw new Error("Binned summary returned invalid quantiles");
  }

  return {
    p05: requiredNumber(quantiles[0], "p05 quantile"),
    p25: requiredNumber(quantiles[1], "p25 quantile"),
    p50: requiredNumber(quantiles[2], "p50 quantile"),
    p75: requiredNumber(quantiles[3], "p75 quantile"),
    p95: requiredNumber(quantiles[4], "p95 quantile"),
  };
}

/** Selects a robust metric range, or the observed extent for a time axis. */
export function binnedSummaryRange(
  statsRows: readonly StudyRow[],
  query: BinnedSummaryQuery,
): [number, number] {
  if (query.range) {
    return [query.range[0], query.range[1]];
  }

  const stats = statsRows[0];
  if (!stats || requiredNumber(stats["n"], "count") === 0) {
    return [0, 0];
  }

  const min = requiredNumber(stats["min"], "minimum");
  const max = requiredNumber(stats["max"], "maximum");
  if (axisKind(query) === "time") {
    return [min, max];
  }

  const quantiles = valuesOf(stats["quantiles"]);
  const lo = optionalNumber(quantiles[0]);
  const hi = optionalNumber(quantiles[6]);
  return lo !== undefined && hi !== undefined && lo < hi ? [lo, hi] : [min, max];
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "t";
}

function groupValue(row: StudyRow): string | number | boolean | null {
  if (booleanValue(row["is_other"])) {
    return "Other";
  }

  if (row["group_lo"] !== null && row["group_lo"] !== undefined) {
    const lo = requiredNumber(row["group_lo"], "group lower edge");
    const width = requiredNumber(row["group_width"], "group width");
    return `${lo}–${lo + width}`;
  }

  const value = row["value"];
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  throw new Error("Binned summary returned an invalid group value");
}

/** Converts database rows into the shared binned-summary result shape. */
export function shapeBinnedSummary(
  rows: readonly StudyRow[],
  query: BinnedSummaryQuery,
  range: [number, number],
): BinnedSummaryResult {
  const kind = axisKind(query);
  const width = kind === "metric" ? (range[1] - range[0]) / numericBins(query.bins) : 0;
  const buckets = rows.map((row) => {
    const bucket = requiredNumber(row["bucket"], "bucket");
    const lo = kind === "metric" ? range[0] + bucket * width : bucket;
    const hi = kind === "metric" ? lo + width : requiredNumber(row["bucket_hi"], "bucket_hi");
    const cohort = row["cohort"];

    return {
      lo,
      hi,
      ...(kind === "time"
        ? { start: new Date(EPOCH_2000_MS + lo * DAY_MS).toISOString().slice(0, 10) }
        : {}),
      group: groupValue({ ...row, group_lo: row['group_lo'] == null ? null : Number(row['group_lo']) + Number(row['value']) * Number(row['group_width']) }),
      ...(cohort === null || cohort === undefined ? {} : { cohort: String(cohort) }),
      n: requiredNumber(row["n"], "count"),
      isOther: booleanValue(row["is_other"]),
      quantiles: rowQuantiles(row),
      mean: requiredNumber(row["mean"], "mean"),
      thin: booleanValue(row["thin"]),
    };
  });

  return { xKind: kind, yKind: query.y === 'created_at' ? 'time' : 'metric', range, buckets };
}
