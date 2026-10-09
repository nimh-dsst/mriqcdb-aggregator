import { fieldValueLabel,type ColumnId,type Filter,type Selection } from "@mriqc/shared";

/**
 * One named group in a custom split: every scan matching all of its filters
 * and metric ranges. Filters merge field values ("Siemens or GE"); ranges cut
 * a band out of a metric ("tSNR 1.5–3"), the same way a brush does.
 */
export interface Bucket {
  readonly name: string;
  readonly filters: readonly Filter[];
  readonly selections?: readonly Selection[];
}

/** Bounds at or past this mean "open" once a range has been through a URL. */
export const OPEN_BOUND = 1e15;

export const MAX_BUCKETS = 5;

/** A descriptor for one explicitly drawn graph series. */
export type Series =
  | { readonly kind: "field"; readonly field: ColumnId }
  | {
      readonly kind: "values";
      readonly field: ColumnId;
      readonly values: readonly string[];
    }
  | { readonly kind: "population" }
  | { readonly kind: "cohort"; readonly id: string }
  | { readonly kind: "study" }
  | { readonly kind: "span"; readonly from: string; readonly to: string }
  | { readonly kind: "buckets"; readonly buckets: readonly Bucket[] };

export interface SeriesContext {
  readonly fieldCount?: (field: string) => number;
  readonly studyReady?: boolean;
  readonly cohortIds?: readonly string[];
}

const MAX_CHROMATIC_SERIES = 6;
const IMPLICIT_DASHBOARD_SERIES = 1;
const MAX_NAMED_FIELD_VALUES = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const distinctValues = (values: readonly string[]): readonly string[] =>
  [...new Set(values)];

const validIsoDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const normalizedFieldCount = (
  field: string,
  fieldCount: SeriesContext["fieldCount"],
): number => {
  const count = fieldCount?.(field);
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return MAX_NAMED_FIELD_VALUES;
  }

  return Math.max(0, Math.floor(count));
};

const isGrouping = (series: Series): boolean =>
  series.kind === "field" || series.kind === "values" || series.kind === "buckets";

const isComparison = (series: Series): boolean => !isGrouping(series);

/**
 * A stable, collision-free identity suitable for de-duplicating descriptors.
 * Value order is not meaningful, so it is canonicalized here as well.
 */
export const seriesKey = (series: Series): string => {
  switch (series.kind) {
    case "field":
      return JSON.stringify([series.kind, series.field]);
    case "values":
      return JSON.stringify([
        series.kind,
        series.field,
        [...distinctValues(series.values)].sort(),
      ]);
    case "population":
    case "study":
      return series.kind;
    case "cohort":
      return JSON.stringify([series.kind, series.id]);
    case "span":
      return JSON.stringify([series.kind, series.from, series.to]);
    case "buckets":
      return JSON.stringify([series.kind, series.buckets.map(bucket => [bucket.name, bucket.filters, bucket.selections ?? []])]);
  }
};

/** A concise label for a descriptor, with optional application-specific labels. */
export const seriesLabel = (
  series: Series,
  fieldLabel: (id: string) => string = (id) => id,
  cohortLabel: (id: string) => string = (id) => id,
): string => {
  switch (series.kind) {
    case "field":
      return `by ${fieldLabel(series.field)}`;
    case "values":
      return `${fieldLabel(series.field)}: ${distinctValues(series.values).map(value => fieldValueLabel(series.field, value)).join(", ")}`;
    case "population":
      return "Whole population";
    case "cohort":
      return cohortLabel(series.id);
    case "study":
      return "My study";
    case "span":
      return spanLabel(series.from, series.to);
    case "buckets":
      return series.buckets.map(bucket => bucket.name).join(" · ");
  }
};

const spanLabel = (from: string, to: string): string => {
  const year = from.slice(0, 4);
  if (from === `${year}-01-01` && to === `${year}-12-31`) {
    return year;
  }

  const format = (value: string, includeYear: boolean): string =>
    new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));

  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${format(from, false)}–${format(to, true)}`;
  }

  return `${format(from, true)}–${format(to, true)}`;
};

/**
 * Number of chromatic slots drawn by a descriptor. The graph also reserves one
 * slot for its dashboard aggregate; the field descriptor's Other slot is neutral.
 */
export const seriesSlots = (
  series: Series,
  fieldCount?: (field: string) => number,
): number => {
  switch (series.kind) {
    case "field":
      return Math.min(
        MAX_NAMED_FIELD_VALUES,
        normalizedFieldCount(series.field, fieldCount),
      );
    case "values":
      return distinctValues(series.values).length;
    case "buckets":
      return series.buckets.length;
    default:
      return 1;
  }
};

/**
 * Explains why adding a descriptor is not currently valid, or returns null.
 * The caller owns the actual add/remove form behavior.
 */
export const seriesDisabledReason = (
  existing: readonly Series[],
  candidate: Series,
  context: SeriesContext = {},
): string | null => {
  const normalizedCandidate = normalizeOne(candidate);
  if (normalizedCandidate === null) {
    return "This series is invalid.";
  }

  const candidateKey = seriesKey(normalizedCandidate);
  if (existing.some((series) => seriesKey(series) === candidateKey)) {
    return "This series is already selected.";
  }

  if (normalizedCandidate.kind === "study" && context.studyReady === false) {
    return "This study is not ready for comparison.";
  }

  if (
    normalizedCandidate.kind === "cohort" &&
    context.cohortIds !== undefined &&
    !context.cohortIds.includes(normalizedCandidate.id)
  ) {
    return "This cohort is not available.";
  }

  const hasGrouping = existing.some(isGrouping);
  if (isGrouping(normalizedCandidate) && hasGrouping) {
    return "Only one grouping series can be selected.";
  }

  if (hasGrouping || isGrouping(normalizedCandidate)) {
    const comparisonCount =
      existing.filter(isComparison).length +
      (isComparison(normalizedCandidate) ? 1 : 0);
    if (comparisonCount > 2) {
      return "A grouping series can be compared with at most two other series.";
    }
  }

  const usedSlots =
    IMPLICIT_DASHBOARD_SERIES +
    existing.reduce(
      (total, series) => total + seriesSlots(series, context.fieldCount),
      0,
    );
  if (
    usedSlots + seriesSlots(normalizedCandidate, context.fieldCount) >
    MAX_CHROMATIC_SERIES
  ) {
    return "Six coloured series plus Other maximum. Remove a comparison or choose fewer values.";
  }

  return null;
};

const normalizeOne = (input: unknown): Series | null => {
  if (!isRecord(input) || typeof input["kind"] !== "string") {
    return null;
  }

  switch (input["kind"]) {
    case "field":
      return isNonEmptyString(input["field"])
        ? { kind: "field", field: input["field"].trim() as ColumnId }
        : null;
    case "values": {
      if (!isNonEmptyString(input["field"]) || !Array.isArray(input["values"])) {
        return null;
      }
      if (!input["values"].every((value): value is string => typeof value === 'string')) {
        return null;
      }
      const values = distinctValues(input["values"]);
      return values.length > 0
        ? {
            kind: "values",
            field: input["field"].trim() as ColumnId,
            values,
          }
        : null;
    }
    case "population":
      return { kind: "population" };
    case "cohort":
      return isNonEmptyString(input["id"])
        ? { kind: "cohort", id: input["id"].trim() }
        : null;
    case "study":
      return { kind: "study" };
    case "span":
      return validIsoDate(input["from"]) &&
        validIsoDate(input["to"]) &&
        input["from"] <= input["to"]
        ? { kind: "span", from: input["from"], to: input["to"] }
        : null;
    case "buckets": {
      if (!Array.isArray(input["buckets"])) return null;
      const buckets = input["buckets"].flatMap((raw): Bucket[] => {
        if (!isRecord(raw) || !isNonEmptyString(raw["name"])) return [];
        const filters = Array.isArray(raw["filters"]) ? raw["filters"].filter(isFilter) : [];
        const selections = Array.isArray(raw["selections"]) ? raw["selections"].filter(isSelection) : [];
        if (!filters.length && !selections.length) return [];
        return [{ name: raw["name"].trim(), filters, ...(selections.length ? { selections } : {}) }];
      }).slice(0, MAX_BUCKETS);
      return buckets.length ? { kind: "buckets", buckets } : null;
    }
    default:
      return null;
  }
};

const isSelection = (value: unknown): value is Selection =>
  isRecord(value) && isNonEmptyString(value["metric"]) && Array.isArray(value["range"]) &&
  value["range"].length === 2 && value["range"].every(bound => typeof bound === "number" && Number.isFinite(bound));

const isFilter = (value: unknown): value is Filter => {
  if (!isRecord(value) || !isNonEmptyString(value["field"])) return false;
  switch (value["op"]) {
    case "in":
      return Array.isArray(value["values"]) && value["values"].length > 0;
    case "between":
      return ["number", "string"].includes(typeof value["lo"]) && ["number", "string"].includes(typeof value["hi"]);
    case "isNull":
    case "notNull":
      return true;
    default:
      return false;
  }
};

/**
 * The split with one of its groups taken out. A whole-field split becomes the
 * explicit values that were showing minus that one; a split down to nothing is
 * removed altogether (null).
 */
export const withoutGroup = (
  series: Series,
  group: string,
  shownValues: readonly string[] = [],
): Series | null => {
  switch (series.kind) {
    case "field": {
      const values = shownValues.filter(value => value !== group);
      return values.length ? { kind: "values", field: series.field, values } : null;
    }
    case "values": {
      const values = series.values.filter(value => value !== group);
      return values.length ? { ...series, values } : null;
    }
    case "buckets": {
      const buckets = series.buckets.filter(bucket => bucket.name !== group);
      return buckets.length ? { ...series, buckets } : null;
    }
    default:
      return null;
  }
};

const asInputList = (input: unknown): readonly unknown[] => {
  if (Array.isArray(input)) {
    return input;
  }

  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return asInputList(parsed);
    } catch {
      return [];
    }
  }

  if (isRecord(input) && "series" in input) {
    return asInputList(input["series"]);
  }

  return [];
};

/**
 * Safely restores a list of descriptors from untrusted persisted or URL state.
 * Invalid descriptors, unavailable cohorts, and duplicate descriptors are omitted.
 */
export const normalizeSeries = (
  input: unknown,
  context: SeriesContext = {},
): readonly Series[] => {
  const normalized: Series[] = [];

  for (const rawSeries of asInputList(input)) {
    const series = normalizeOne(rawSeries);
    if (series === null || seriesDisabledReason(normalized, series, context) !== null) {
      continue;
    }
    normalized.push(series);
  }

  return normalized;
};
