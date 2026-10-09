/**
 * The vocabulary the DuckDB server and the Angular dashboard both speak.
 *
 * Shapes follow `docs/backend-graph.md` ("Serving schema", "Metric catalog",
 * "Query templates and the filter compiler", "Procedures") and
 * `docs/dashboard-graph.md` ("Query keys and procedures").
 */

/* ------------------------------------------------------------------ basics */

/** The MRIQC modalities the aggregator ingests. */
export type Modality = 'bold' | 'T1w' | 'T2w';

/** Every modality, in the order the UI lists them. */
export const MODALITIES: readonly Modality[] = ['bold', 'T1w', 'T2w'] as const;

/**
 * A servable table: the raw upload log, one canonical policy output, or that
 * policy output with its quarantined raw rows added back.
 * `k4plus*` exists for bold only, `k3pp*` for T1w and T2w only.
 *
 * The `_all` views are the policy's whole corpus: one row per admitted group
 * plus every raw row the policy quarantined, so nothing is dropped and the
 * canonical-only columns are NULL on the quarantined half.
 */
export type View = 'raw' | 'k4plus' | 'k3pp' | 'k4plus_all' | 'k3pp_all';

/** Every view id. Which ones a modality actually has comes from the catalog. */
export const VIEWS: readonly View[] = [
  'raw',
  'k4plus',
  'k3pp',
  'k4plus_all',
  'k3pp_all',
] as const;

/**
 * A normalized column name, as produced by `normalizeColumnName`. Branded so a
 * plain string cannot be passed where a catalog-validated column is required.
 */
export type ColumnId = string & { readonly __columnId: unique symbol };

/** A catalog metric identifier; validated for the requested modality at runtime. */
export type MetricId = ColumnId;
/** A continuous x axis: a catalog metric or upload time. */
export type ColumnRef = MetricId | 'created_at';

/** Assert that a string is a column id. Only the catalog and the DB build mint these. */
export function asColumnId(value: string): ColumnId {
  return value as ColumnId;
}

/** Schema version of the metric catalog the server and web app agree on. */
export const CATALOG_VERSION = '0.2.0';

/* ----------------------------------------------------------------- catalog */

/** Default x-range clipping for a metric's histogram. */
export type ClipMode = 'p01p99' | 'p05p95' | 'none';

/** What a non-metric column may be used for. */
export type FieldRole = 'filter' | 'group' | 'export';

/** How a non-metric column behaves in filters, grouping, and axes. */
export type FieldKind = 'categorical' | 'date' | 'numeric';

/**
 * Where a metric's authored `description` came from.
 *
 * `mriqc-docs` is a paraphrase of MRIQC's own IQM documentation, which
 * `docsUrl` links to; `authored` is everything the IQM pages do not define --
 * today just the image-header geometry columns (`size_*`, `spacing_*`), whose
 * `docsUrl` points at the modality's IQM page without an anchor.
 */
export type MetricSource = 'mriqc-docs' | 'authored';

/** Whether a metric's `higherIsBetter` is documented or only conventional. */
export type DirectionSource = 'mriqc-docs' | 'convention';

/** One image-quality metric, as authored. */
export interface MetricDef {
  id: ColumnId;
  label: string;
  /**
   * A short name for the chip-sized places a full label does not fit -- the
   * brush chip above all, which reads "Brushed: FD mean 0.1-0.4" and not
   * "Brushed: Mean framewise displacement 0.1-0.4". Absent when the label is
   * already short enough, and every reader falls back to `label`.
   */
  shortLabel?: string;
  family: string;
  subfamily?: string;
  description?: string;
  unit?: string;
  /**
   * True when a larger value is the better one, false when a smaller value is,
   * and null when there is no single direction -- either because MRIQC's docs
   * name a target interval instead (`wm2max` should sit around 0.6-0.8,
   * `icvs_*` "within a normative range") or because they state no direction at
   * all. Null and not "obviously lower", so the UI never asserts a direction
   * the documentation does not back.
   */
  higherIsBetter?: boolean | null;
  /**
   * Where `higherIsBetter` came from, so the UI never passes off a convention
   * as documentation: `mriqc-docs` when the IQM page states the direction in
   * words, `convention` when the field agrees on it but the docs only describe
   * the measure (head motion, SNR, DVARS, ghosting). Absent exactly when
   * `higherIsBetter` is null.
   */
  directionSource?: DirectionSource;
  /** Where `description` came from. Absent means `authored`. */
  source?: MetricSource;
  /** Deep link to the documentation section `description` paraphrases. */
  docsUrl?: string;
  modalities: readonly Modality[];
  clipDefault: ClipMode;
  logScale?: boolean;
}

/** One non-metric column: acquisition metadata, provenance, or identity. */
export interface FieldDef {
  id: ColumnId;
  label: string;
  kind: FieldKind;
  modalities: readonly Modality[];
  filterable: boolean;
  groupable: boolean;
  exportable: boolean;
  /**
   * Views this field exists in, when it is not all of them. Absent means every
   * view of every modality listed above. `canonical_hmc_mode` uses this: it is a
   * bold column that only the canonical table carries.
   */
  views?: readonly View[];
  /**
   * True for a long-tail or diagnostic field: it is filterable, but it is not
   * one of the handful a reader reaches for, so the top bar puts it in "More
   * filters" instead of the primary row (`chrome` in
   * `web/src/app/graph/projections.ts`).
   *
   * A flag and not a hard-coded list in the UI: which fields are everyday and
   * which are long-tail is a fact about the field, so it is authored beside the
   * field and a new one gets an answer without a second place to edit.
   */
  secondary?: boolean;
}

/** One servable table, named for the UI. */
export interface ViewDef {
  id: View;
  label: string;
  modalities: readonly Modality[];
  /** Canonicalization policy id, e.g. `K4+`. Absent for `raw`. */
  policy?: string;
  /**
   * True for a policy view that carries the quarantined raw rows as well as the
   * canonical ones. Set on the `_all` views, so the UI can tell "the policy's
   * answer" from "the policy's answer plus what it refused".
   */
  includesQuarantined?: boolean;
}

/** Everything the catalog knows without opening the database. */
export interface AuthoredCatalog {
  version: string;
  metrics: readonly MetricDef[];
  fields: readonly FieldDef[];
  views: readonly ViewDef[];
}

/** One distinct value of a categorical field, with how many rows carry it. */
export interface FieldValueCount {
  value: string | number | boolean | null;
  n: number;
}

/**
 * The label every value list, axis and legend shows for a categorical value that
 * is not there.
 *
 * SQL `NULL` and the empty string are indistinguishable to a reader -- both
 * render as nothing, which is how a filter list came to offer an unlabelled
 * option with 239,400 rows behind it -- so they are one bucket everywhere: the
 * completed catalog merges them, and a filter on the bucket matches both.
 *
 * "Not reported" and not "(none)": the bucket is a fact about the upload --
 * nobody wrote the field down -- and "(none)" reads as a value of zero, or as
 * an empty filter, to everyone who has not read this comment.
 */
export const NONE_LABEL = 'Not reported';

/**
 * The wire value a `(none)` filter carries.
 *
 * The empty string rather than null, because a `Filter`'s values are
 * `FilterValue`s and null is not one. The server's filter compiler expands it
 * back to "is null or is the empty string".
 */
export const NONE_FILTER_VALUE = '';

/** True when a categorical value belongs in the `(none)` bucket. */
export function isNoneValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** How one categorical value is written for a human. */
export function categoryLabel(value: string | number | boolean | null | undefined): string {
  return isNoneValue(value) ? NONE_LABEL : String(value);
}

/**
 * Display names for the stored values of a few categorical fields, keyed by
 * field id and then by the value exactly as the database holds it.
 *
 * Display only. Filters, query keys and shared links keep carrying the stored
 * value, so nothing here can change what a chart is counting -- `afni` filters
 * on `afni` and reads "AFNI (3dvolreg)". It is here rather than in the web
 * package because the axis labels, the legends and the filter lists all need
 * the same answer and only one of them is a component.
 */
const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  canonical_hmc_mode: {
    afni: 'AFNI (3dvolreg)',
    fsl: 'FSL (MCFLIRT)',
    unknown: 'Unknown',
  },
};

/**
 * How one value of one field is written for a human: the field's own name for
 * it where there is one, otherwise `categoryLabel`.
 */
export function fieldValueLabel(
  fieldId: string | null | undefined,
  value: string | number | boolean | null | undefined,
): string {
  if (isNoneValue(value)) return NONE_LABEL;
  const named = fieldId ? VALUE_LABELS[fieldId]?.[String(value)] : undefined;
  return named ?? String(value);
}

/** Inclusive `created_at` bounds, as ISO-8601 strings. */
export interface DateRange {
  min: string;
  max: string;
}

/**
 * The finite bounds of one numeric filterable column in one `(modality, view)`.
 *
 * The top bar's two-ended range control shows these as its placeholders, so the
 * user types against the range the data actually spans rather than guessing.
 * Null bounds are impossible: a column with no finite value has no entry at all.
 */
export interface NumericRange {
  min: number;
  max: number;
}

/**
 * What one modality's canonicalization policy refused: whole identity groups and
 * the raw rows in them. Both counts come from `meta.policies`, which the build
 * writes from the admission rule itself, so the UI never recomputes them.
 */
export interface QuarantineCounts {
  groups: number;
  rows: number;
}

/** A per-modality, per-view fact table. Missing keys mean "no such (modality, view)". */
export type ByModalityView<T> = Partial<Record<Modality, Partial<Record<View, T>>>>;

/**
 * The authored catalog plus the facts only the database knows, computed once per
 * `dataVersion` and cached. See backend-graph.md, "Metric catalog".
 */
export interface CompletedCatalog extends AuthoredCatalog {
  /** Value lists for each categorical filterable field, keyed by field id, capped at 200 values ordered by count. */
  fieldValues: Record<string, ByModalityView<readonly FieldValueCount[]>>;
  /** `created_at` bounds per modality, or null when the modality has no dated rows. */
  dateRange: Partial<Record<Modality, DateRange | null>>;
  /**
   * Min and max per numeric filterable field, keyed by field id, so the top bar's
   * range controls can place their bounds. A `(modality, view)` with no finite
   * value for the field has no entry.
   */
  numericRange: Record<string, ByModalityView<NumericRange>>;
  /** Finite-value count per metric, keyed by metric id, so the UI can grey out empty metrics. */
  metricCounts: Record<string, ByModalityView<number>>;
  /** Which views each modality actually has, from `meta.policies`. */
  availableViews: Partial<Record<Modality, readonly View[]>>;
  /**
   * What each modality's canonical policy quarantined, from `meta.policies`.
   * Absent for a modality with no policy view at all.
   */
  quarantine: Partial<Record<Modality, QuarantineCounts>>;
  /** The ingest version these facts were computed at; the ETag of every response. */
  dataVersion: string;
}

/* ----------------------------------------------------- filters and selection */

/** A value an `in` filter may match. */
export type FilterValue = string | number | boolean;

/**
 * One predicate against a filterable column. The server rejects any field the
 * catalog does not mark filterable, any `in` list over 500 values, and any
 * `between` on a categorical field.
 */
export type Filter =
  | { field: ColumnId; op: 'in'; values: readonly FilterValue[] }
  | { field: ColumnId; op: 'between'; lo: number | string; hi: number | string }
  | { field: ColumnId; op: 'isNull' | 'notNull' };

/** A brushed interval on one metric's axis, applied as an extra predicate. */
export interface Selection {
  metric: ColumnId;
  range: [number, number];
}

/** Up to four distinct metric ranges, ANDed with the ordinary filters. */
export interface SelectionScope {
  selections?: readonly Selection[];
  /** @deprecated Use selections. Supplying both non-null forms is an error. */
  selection?: Selection | null;
}

/* --------------------------------------------------------------- panel enums */

/** Calendar bucket width for coverage and time summaries. */
export type Granularity = 'day' | 'week' | 'month' | 'year';

/** What a panel renders. Which charts a panel kind allows is fixed per kind. */
export type ChartType =
  | 'histogram'
  | 'ecdf'
  | 'box'
  | 'facetedHistogram'
  | 'facetedEcdf'
  | 'stackedBar'
  | 'area'
  | 'table'
  | 'overlaidHistogram'
  | 'overlaidEcdf';

/** The five panel kinds the dashboard supports. */
export type PanelKind = 'distribution' | 'grouped' | 'coverage' | 'sample' | 'comparison';

/* ------------------------------------------------------- procedure results */

/** The seven quantiles `distribution` returns in one `quantile_cont` aggregate. */
export interface Quantiles {
  p01: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
}

/** An equal-width histogram over a clipped range; `counts.length` is the bin count. */
export interface Histogram {
  lo: number;
  hi: number;
  width: number;
  counts: readonly number[];
}

/** Summary statistics over the finite values of one metric. Null when `n` is 0. */
export interface MetricSummary {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stddev: number | null;
  quantiles: Quantiles | null;
}

/**
 * A `distribution` histogram: the equal-width bins plus, when the caller asked
 * for an explicit `range`, how many finite values fell outside it.
 *
 * A comparison panel asks every cohort for the same `[lo, hi]` so the overlaid
 * bars share bin edges, which means each cohort can have values the shared range
 * does not cover. Reporting those two counts is what keeps the histogram honest:
 * `sum(counts) + underflow + overflow === n`, so nothing is silently dropped.
 */
export interface DistributionHistogram extends Histogram {
  /** Finite values below `lo`. Absent, or 0, when no explicit range was asked for. */
  underflow?: number;
  /** Finite values above `hi`. Absent, or 0, when no explicit range was asked for. */
  overflow?: number;
}

/** Output of the `distribution` procedure. */
export interface DistributionResult extends MetricSummary {
  histogram: DistributionHistogram;
}

/** One group's slice of a `groupedSummary`. */
export interface GroupSummary extends MetricSummary {
  /** The group value, or a bin label when the group column is numeric. */
  value: string | number | boolean | null;
  histogram: Histogram;
}

/** Output of the `groupedSummary` procedure: up to 50 groups plus an `other` fold. */
export interface GroupedSummaryResult {
  groups: readonly GroupSummary[];
  other?: GroupSummary;
}

/** One `(time bucket, group value)` cell of a coverage result. */
export interface CoverageBucket {
  /** Bucket start, ISO-8601. */
  start: string;
  group: string | number | boolean | null;
  n: number;
}

/** Output of the `coverage` procedure. */
export interface CoverageResult {
  buckets: readonly CoverageBucket[];
}

/** An additional series predicate, ANDed with the query's outer scope. */
export interface BinnedSummaryCohort extends SelectionScope {
  id: string;
  filters: readonly Filter[];
}

export interface BinnedSummaryInput extends SelectionScope {
  modality: Modality;
  view: View;
  filters?: readonly Filter[];
  x: ColumnRef;
  y: MetricId;
  bins: number | Granularity;
  /** Metric units, or days since 2000-01-01 for time. */
  range?: [number, number];
  groups?: ColumnId;
  cohorts?: readonly BinnedSummaryCohort[];
}

/** Finite y statistics in one occupied x bin and series. */
export interface BinnedSummaryBucket {
  lo: number;
  hi: number;
  /** ISO calendar bucket start, present for time x. */
  start?: string;
  group: string | number | boolean | null;
  cohort?: string;
  n: number;
  /** Distinguishes the capped remainder from a category literally named Other. */
  isOther: boolean;
  quantiles: Pick<Quantiles, 'p05' | 'p25' | 'p50' | 'p75' | 'p95'>;
  mean: number;
  /** Fewer than 20 finite observations; the bucket is still returned. */
  thin: boolean;
}

export interface BinnedSummaryResult {
  xKind: 'metric' | 'time';
  range: [number, number];
  buckets: readonly BinnedSummaryBucket[];
}

/** One row of a `sample`, keyed by the allowlisted column ids that were requested. */
export type SampleRow = Readonly<Record<string, string | number | boolean | null>>;

/** Output of the `sample` procedure; `nextCursor` is null at the end of the keyset. */
export interface SampleResult {
  rows: readonly SampleRow[];
  nextCursor: string | null;
}

/**
 * A two-dimensional equal-width histogram over a clipped x/y range.
 *
 * `counts` is row-major: the cell at `(bx, by)` is
 * `counts[by * bins + bx]`. Values outside the requested range are accounted
 * for by the four counters. Assignment is x-first and mutually exclusive:
 * x underflow/overflow is recorded on x; y underflow/overflow is recorded
 * only when x is in range. Therefore the grid plus all four counters sums to
 * `n`.
 */
export interface Density2dResult {
  /** Time x edges and samples are days since 2000-01-01. */
  xKind: 'metric' | 'time';
  x: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  y: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  counts: number[];
  n: number;
  pearson: number | null;
  spearman: number | null;
  sample: Array<[number, number]>;
}

export interface Density2dInput extends SelectionScope {
  modality: Modality;
  view: View;
  filters?: readonly Filter[];
  x: ColumnRef;
  y: MetricId;
  bins?: number;
  clip?: ClipMode;
  range?: { x: [number, number]; y: [number, number] };
  sampleSize?: number;
  seed?: number;
}

/**
 * Pairwise correlation metrics and finite-pair counts in input metric order.
 * Undefined coefficients (fewer than two pairs or zero variance) are NaN in
 * process and JSON null on the wire. Such diagonals are undefined, not one.
 * Spearman uses average tied ranks over each metric's own finite population,
 * followed by pairwise deletion, rather than reranking separately for each pair.
 */
export interface CorrelationResult {
  metrics: ColumnId[];
  pearson?: number[][];
  spearman?: number[][];
  pairN: number[][];
  minPairN: number;
}
