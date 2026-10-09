import {
  asColumnId,
  getAuthoredCatalog,
  quoteIdent,
  type TimeSummaryQuery,
  type TimeSummaryResult,
} from "@mriqc/shared";

import {
  compileStudyStatement,
  metricExpression,
  predicate,
  type BoundStatement,
  type StudyRow,
} from "./study-sql";

const GRANULARITIES = new Set(["day", "week", "month", "year"]);

function groupField(query: TimeSummaryQuery, columns: ReadonlySet<string>) {
  if (query.group === undefined) {
    return undefined;
  }

  const field = getAuthoredCatalog().fields.find(
    (candidate) => candidate.id === query.group,
  );
  if (
    field === undefined ||
    field.groupable !== true ||
    !field.modalities.includes(query.modality) ||
    !columns.has(String(query.group))
  ) {
    throw new Error(`Invalid time-summary group: ${String(query.group)}`);
  }
  return field;
}

function checkedWindow(window: TimeSummaryQuery["window"]): TimeSummaryQuery["window"] {
  if (window === undefined) {
    return undefined;
  }
  const [lo, hi] = window;
  const loTime = Date.parse(lo);
  const hiTime = Date.parse(hi);
  if (!Number.isFinite(loTime) || !Number.isFinite(hiTime) || loTime > hiTime) {
    throw new Error("time-summary window must contain two ordered, finite dates");
  }
  return window;
}

/** Compiles the bucketed quantile query used by the study time-summary view. */
export function compileStudyTimeSummary(
  query: TimeSummaryQuery,
  columns: ReadonlySet<string>,
): BoundStatement {
  if (!columns.has("created_at")) {
    throw new Error("time-summary requires the created_at column");
  }
  if (!GRANULARITIES.has(query.granularity)) {
    throw new Error(`Invalid time-summary granularity: ${String(query.granularity)}`);
  }

  const window = checkedWindow(query.window);
  const group = groupField(query, columns);
  const compiledPredicate = predicate(query, columns);
  const where = window === undefined ? compiledPredicate.where
    : `${compiledPredicate.where} AND created_at BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)`;
  return compileStudyStatement(
    "time_summary",
    "buckets",
    {
      table: '"study"',
      where,
      metric: metricExpression(query.modality, query.metric, columns),
      granularity: `'${query.granularity}'`,
      group_expr: group === undefined ? "NULL::VARCHAR" : `CAST(${quoteIdent(query.group!)} AS ${group.kind === "numeric" ? "DOUBLE" : "VARCHAR"})`,
      group_numeric: group?.kind === "numeric" ? "TRUE" : "FALSE",
      group_bins: "10",
      max_groups: "50",
    },
    [...compiledPredicate.params, ...(window ?? [])],
  );
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function finiteCount(value: unknown): number {
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw new TypeError("n must be a bigint or number");
  }
  const count = Number(value);
  if (!Number.isFinite(count)) {
    throw new TypeError("n must be finite");
  }
  return count;
}

function bucketDate(value: unknown): string {
  let date: Date;
  if (typeof value === "number" || typeof value === "string") {
    date = new Date(value);
  } else if (value instanceof Date) {
    date = value;
  } else {
    throw new TypeError("bucket must be an Arrow timestamp, Date, or date string");
  }
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("bucket must be a finite date");
  }
  return date.toISOString().slice(0, 10);
}

function quantiles(value: unknown): {
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
} {
  if (
    value === null ||
    value === undefined ||
    typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("qs must be iterable");
  }
  const values = Array.from(value as Iterable<unknown>);
  if (values.length !== 5) {
    throw new TypeError("qs must contain five quantiles");
  }
  return {
    p05: finiteNumber(values[0], "p05"),
    p25: finiteNumber(values[1], "p25"),
    p50: finiteNumber(values[2], "p50"),
    p75: finiteNumber(values[3], "p75"),
    p95: finiteNumber(values[4], "p95"),
  };
}

function primitiveValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError("value must be a primitive or null");
}

function numericLabel(value: unknown, lo: unknown, width: unknown): string | undefined {
  if (lo === null || width === null || lo === undefined || width === undefined) {
    return undefined;
  }
  const index = Number(value);
  if (!Number.isFinite(index)) {
    throw new TypeError("value must be a finite numeric group index");
  }
  const first = finiteNumber(lo, "group_lo");
  const size = finiteNumber(width, "group_width");
  if (size <= 0) {
    throw new TypeError("group_width must be positive");
  }
  const decimals = Math.min(15, Math.max(4, Math.ceil(-Math.log10(size)) + 2));
  const edge = (number: number) => String(Number(number.toFixed(decimals)));
  const lower = first + size * index;
  return `${edge(lower)}–${edge(lower + size)}`;
}

/** Converts Arrow/SQL rows to the API's stable, JSON-friendly time-summary result. */
export function shapeTimeSummary(rows: readonly StudyRow[]): TimeSummaryResult {
  const buckets = rows.map((row) => {
    const isOther = row["is_other"] === true;
    const groupLabel = isOther
      ? undefined
      : numericLabel(row["value"], row["group_lo"], row["group_width"]);
    return {
      start: bucketDate(row["bucket"]),
      group: isOther ? "Other" : (groupLabel ?? primitiveValue(row["value"])),
      isOther,
      n: finiteCount(row["n"]),
      quantiles: quantiles(row["qs"]),
      mean: finiteNumber(row["mean"], "mean"),
      thin: row["thin"] === true,
    };
  });
  return { buckets };
}
