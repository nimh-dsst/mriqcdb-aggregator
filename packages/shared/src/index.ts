/**
 * `@mriqc/shared` -- the domain vocabulary the DuckDB server and the Angular
 * dashboard both compile against: catalog types, the authored catalog itself,
 * column-name normalization, and query-key serialization.
 */

export type {
  AuthoredCatalog,
  BinnedSummaryBucket,
  BinnedSummaryCohort,
  BinnedSummaryInput,
  BinnedSummaryResult,
  ByModalityView,
  ChartType,
  ClipMode,
  ColumnId,
  ColumnRef,
  CompletedCatalog,
  CorrelationResult,
  CoverageBucket,
  CoverageResult,
  DateRange,
  Density2dResult,
  Density2dInput,
  DistributionHistogram,
  DistributionResult,
  FieldDef,
  FieldKind,
  FieldRole,
  FieldValueCount,
  Filter,
  FilterValue,
  Granularity,
  GroupSummary,
  GroupedSummaryResult,
  Histogram,
  MetricDef,
  MetricId,
  MetricSummary,
  Modality,
  NumericRange,
  PanelKind,
  Quantiles,
  QuarantineCounts,
  SampleResult,
  SampleRow,
  Selection,
  SelectionScope,
  View,
  ViewDef,
} from './types.js';

export {
  asColumnId,
  categoryLabel,
  CATALOG_VERSION,
  fieldValueLabel,
  isNoneValue,
  MODALITIES,
  NONE_FILTER_VALUE,
  NONE_LABEL,
  VIEWS,
} from './types.js';

export { DROPPED_COLUMNS, isDroppedColumn, normalizeColumnName } from './normalize.js';

export type { Query, QueryKey, QuerySource, BinnedSummaryQuery } from './query.js';
export { queryKey } from './query.js';

/**
 * The statistics SQL both runners compile, and the pure core of the filter
 * compiler they both build predicates with. See `sql/templates.ts`.
 */
export type { TemplateName } from './sql/templates.js';
export {
  COVERAGE_SQL,
  CORRELATION_SQL,
  DENSITY2D_SQL,
  DISTRIBUTION_SQL,
  EXPORT_SQL,
  GROUPED_SUMMARY_SQL,
  SAMPLE_SQL,
  BINNED_SUMMARY_SQL,
  SQL_TEMPLATES,
  parseStatements,
  statementsOf,
} from './sql/templates.js';

export { correlationFragments } from './sql/correlation.js';
export { continuousAxisExpr, binnedSummaryFragments } from './sql/continuous-axis.js';

export type { CompiledFilters, FilterColumn, FilterValidator } from './sql/filters-core.js';
export {
  ALLOWED_OPS,
  FilterError,
  MAX_IN_VALUES,
  MAX_SELECTIONS,
  compileFiltersCore,
  isIsoDateString,
  normalizeSelections,
  quoteIdent,
  quoteLiteral,
} from './sql/filters-core.js';

export {
  canonicalViewFor,
  exportableColumnsFor,
  fieldsFor,
  getAuthoredCatalog,
  isValidField,
  isValidMetric,
  metricsFor,
  viewsFor,
} from './catalog/authored.js';
