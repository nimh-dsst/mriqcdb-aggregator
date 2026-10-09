import { normalizeSelections, type BinnedSummaryQuery } from '@mriqc/shared';
import {
  FilterError,
  compileFiltersCore,
  getAuthoredCatalog,
  quoteIdent,
  statementsOf,
  type ClipMode,
  type DistributionResult,
  type FieldDef,
  type FilterValue,
  type GroupSummary,
  type GroupedSummaryResult,
  type MetricSummary,
  type Modality,
  type Quantiles,
  type TemplateName,
} from '@mriqc/shared';
import type { StudyDistributionQuery, StudyGroupedSummaryQuery, StudyDensity2dQuery, StudyCorrelationQuery } from '../api/api';

export type StudyParam = FilterValue;
export type StudyRow = Readonly<Record<string, unknown>>;

export interface BoundStatement {
  template: 'distribution' | 'grouped_summary' | 'density2d' | 'correlation' | 'binned_summary';
  statement: string;
  sql: string;
  params: readonly StudyParam[];
}

export interface GroupExpression {
  expr: string;
  params: readonly number[];
  label(value: unknown): unknown;
}

export interface CompiledDistribution {
  stats: BoundStatement;
  histogram(lo: number, hi: number, bins: number, ranged: boolean): BoundStatement;
}

export interface CompiledGroupedSummary {
  field: FieldDef;
  groupRange: BoundStatement | null;
  statements(bounds: { lo: number; width: number } | null): {
    group: GroupExpression;
    stats: BoundStatement;
    histogram(lo: number, hi: number, bins: number): BoundStatement;
  };
}

export const MAX_STUDY_GROUPS = 50;
export const STUDY_GROUPED_HISTOGRAM_BINS = 30;
export const STUDY_NUMERIC_GROUP_BINS = 10;

const catalog = getAuthoredCatalog();

function fill(sql: string, holes: Readonly<Record<string, string>>): string {
  const result = sql.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const replacement = holes[key];
    if (replacement === undefined) throw new Error(`No value for SQL template hole {{${key}}}`);
    return replacement;
  });
  if (/\{\{\w+\}\}/.test(result)) throw new Error('The study SQL has an unfilled template hole');
  return result;
}

/** Pure shared-template compiler: SQL text and positional values stay inspectable in tests. */
export function compileStudyStatement(
  template: BoundStatement['template'],
  statement: string,
  holes: Readonly<Record<string, string>>,
  params: readonly StudyParam[],
): BoundStatement {
  const source = statementsOf(template as TemplateName).get(statement);
  if (source === undefined)
    throw new Error(`The ${template} template has no ${statement} statement`);
  return { template, statement, sql: fill(source, holes), params: [...params] };
}

function hasMetric(modality: Modality, metric: string, columns: ReadonlySet<string>): boolean {
  return (
    columns.has(metric) &&
    catalog.metrics.some(
      (definition) => definition.id === metric && definition.modalities.includes(modality),
    )
  );
}

export function metricExpression(
  modality: Modality,
  metric: string,
  columns: ReadonlySet<string>,
): string {
  if (!hasMetric(modality, metric, columns)) {
    throw new FilterError(`The uploaded study has no metric "${metric}" for ${modality}`);
  }
  return `CAST(${quoteIdent(metric)} AS DOUBLE)`;
}

function findField(
  modality: Modality,
  fieldId: string,
  columns: ReadonlySet<string>,
  role: 'filter' | 'group',
): FieldDef {
  if (!columns.has(fieldId)) throw new FilterError(`The uploaded study has no column "${fieldId}"`);
  const field = catalog.fields.find(
    (definition) =>
      definition.id === fieldId &&
      definition.modalities.includes(modality) &&
      (role === 'filter' ? definition.filterable : definition.groupable),
  );
  if (field === undefined) {
    throw new FilterError(`Column "${fieldId}" is not a ${role} field for ${modality}`);
  }
  return field;
}

export function predicate(
  query: BinnedSummaryQuery | StudyDistributionQuery | StudyGroupedSummaryQuery | StudyDensity2dQuery | StudyCorrelationQuery,
  columns: ReadonlySet<string>,
): { where: string; params: readonly StudyParam[] } {
  return compileFiltersCore(query.filters, normalizeSelections(query), {
    field: (fieldId) => {
      const field = findField(query.modality, fieldId, columns, 'filter');
      return { id: field.id, kind: field.kind };
    },
    metric: (metricId) => {
      if (!hasMetric(query.modality, metricId, columns)) {
        throw new FilterError(
          `The uploaded study has no selection metric "${metricId}" for ${query.modality}`,
        );
      }
      return metricId;
    },
  });
}

export function compileStudyDistribution(
  query: StudyDistributionQuery,
  columns: ReadonlySet<string>,
): CompiledDistribution {
  const compiled = predicate(query, columns);
  const holes = {
    table: quoteIdent('study'),
    metric: metricExpression(query.modality, query.metric, columns),
    where: compiled.where,
  };
  return {
    stats: compileStudyStatement('distribution', 'stats', holes, compiled.params),
    histogram: (lo, hi, bins, ranged) => {
      const width = (hi - lo) / bins;
      return ranged
        ? compileStudyStatement('distribution', 'histogram_ranged', holes, [
            ...compiled.params,
            lo,
            hi,
            bins,
            bins,
            lo,
            width,
          ])
        : compileStudyStatement('distribution', 'histogram', holes, [
            ...compiled.params,
            bins,
            lo,
            width,
            lo,
            hi,
          ]);
    },
  };
}

function groupValueExpression(field: FieldDef): string {
  return field.kind === 'numeric'
    ? `CAST(${quoteIdent(field.id)} AS DOUBLE)`
    : `CAST(${quoteIdent(field.id)} AS VARCHAR)`;
}

function binLabelDecimals(width: number): number {
  if (!(width > 0) || !Number.isFinite(width)) return 4;
  return Math.min(15, Math.max(4, Math.ceil(-Math.log10(width)) + 2));
}

function binLabel(lo: number, width: number, index: number): string {
  const decimals = binLabelDecimals(width);
  const edge = (offset: number): string =>
    String(Number((lo + width * (index + offset)).toFixed(decimals)));
  return `${edge(0)}–${edge(1)}`;
}

export function studyGroupExpression(
  field: FieldDef,
  bounds: { lo: number; width: number } | null,
): GroupExpression {
  const identity = (value: unknown): unknown => value;
  if (field.kind !== 'numeric')
    return { expr: groupValueExpression(field), params: [], label: identity };
  if (bounds === null || !(bounds.width > 0)) {
    return { expr: `${groupValueExpression(field)}::VARCHAR`, params: [], label: identity };
  }
  const value = `CAST(${quoteIdent(field.id)} AS DOUBLE)`;
  const index =
    `least(${STUDY_NUMERIC_GROUP_BINS - 1}, greatest(0,` +
    ` CAST(floor((${value} - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) AS BIGINT)))`;
  return {
    expr: `CASE WHEN ${value} IS NULL OR NOT isfinite(${value}) THEN NULL ELSE ${index} END`,
    params: [bounds.lo, bounds.width],
    label: (raw) =>
      raw === null || raw === undefined ? null : binLabel(bounds.lo, bounds.width, Number(raw)),
  };
}

export function compileStudyGroupedSummary(
  query: StudyGroupedSummaryQuery,
  columns: ReadonlySet<string>,
): CompiledGroupedSummary {
  const compiled = predicate(query, columns);
  const metric = metricExpression(query.modality, query.metric, columns);
  const field = findField(query.modality, query.group, columns, 'group');
  const common = { table: quoteIdent('study'), metric, where: compiled.where };
  const groupRange =
    field.kind === 'numeric'
      ? compileStudyStatement(
          'grouped_summary',
          'group_range',
          { ...common, group_expr: groupValueExpression(field) },
          compiled.params,
        )
      : null;
  return {
    field,
    groupRange,
    statements: (bounds) => {
      const group = studyGroupExpression(field, bounds);
      const holes = { ...common, group_expr: group.expr };
      const groupParams = [...group.params, ...compiled.params];
      return {
        group,
        stats: compileStudyStatement('grouped_summary', 'stats', holes, [
          ...groupParams,
          MAX_STUDY_GROUPS,
          MAX_STUDY_GROUPS,
        ]),
        histogram: (lo, hi, bins) =>
          compileStudyStatement('grouped_summary', 'histograms', holes, [
            ...groupParams,
            MAX_STUDY_GROUPS,
            MAX_STUDY_GROUPS,
            bins,
            lo,
            (hi - lo) / bins,
            lo,
            hi,
          ]),
      };
    },
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) && typeof value !== 'number' ? null : parsed;
}

function quantileValues(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && Symbol.iterator in value) {
    return [...(value as Iterable<unknown>)];
  }
  return null;
}

function toQuantiles(value: unknown): Quantiles | null {
  const values = quantileValues(value);
  if (values === null || values.length !== 7) return null;
  const [p01, p05, p25, p50, p75, p95, p99] = values.map(Number);
  return {
    p01: p01 as number,
    p05: p05 as number,
    p25: p25 as number,
    p50: p50 as number,
    p75: p75 as number,
    p95: p95 as number,
    p99: p99 as number,
  };
}

export function shapeMetricSummary(row: StudyRow | undefined): MetricSummary {
  return {
    n: Number(row?.['n'] ?? 0),
    min: numberOrNull(row?.['min']),
    max: numberOrNull(row?.['max']),
    mean: numberOrNull(row?.['mean']),
    stddev: numberOrNull(row?.['stddev']),
    quantiles: toQuantiles(row?.['quantiles']),
  };
}

export function studyHistogramRange(summary: MetricSummary, clip: ClipMode): [number, number] {
  const quantiles = summary.quantiles;
  let range: [number, number];
  if (clip === 'p01p99' && quantiles !== null) range = [quantiles.p01, quantiles.p99];
  else if (clip === 'p05p95' && quantiles !== null) range = [quantiles.p05, quantiles.p95];
  else range = [summary.min ?? 0, summary.max ?? 0];
  if (range[1] > range[0]) return range;
  return summary.min !== null && summary.max !== null && summary.max > summary.min
    ? [summary.min, summary.max]
    : range;
}

function densify(rows: readonly StudyRow[], bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (const row of rows) {
    const bin = Number(row['bin']);
    if (Number.isInteger(bin) && bin >= 0 && bin < bins) counts[bin] = Number(row['n']);
  }
  return counts;
}

function outsideCount(rows: readonly StudyRow[], bin: number): number {
  const row = rows.find((candidate) => Number(candidate['bin']) === bin);
  return row === undefined ? 0 : Number(row['n']);
}

export function shapeDistributionResult(
  summary: MetricSummary,
  rows: readonly StudyRow[],
  bins: number,
  lo: number,
  hi: number,
  ranged: boolean,
): DistributionResult {
  const width = (hi - lo) / bins;
  if (!ranged && !(hi > lo)) {
    return {
      ...summary,
      histogram: { lo, hi, width: 0, counts: summary.n === 0 ? [] : [summary.n] },
    };
  }
  return {
    ...summary,
    histogram: {
      lo,
      hi,
      width,
      counts: densify(rows, bins),
      ...(ranged ? { underflow: outsideCount(rows, -1), overflow: outsideCount(rows, bins) } : {}),
    },
  };
}

function jsonValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return String(value);
}

/** Reproduce server grouping, including a distinct folded `other` result. */
export function shapeGroupedSummaryResult(
  statRows: readonly StudyRow[],
  histogramRows: readonly StudyRow[],
  group: GroupExpression,
  lo: number,
  hi: number,
  bins: number,
): GroupedSummaryResult {
  if (statRows.length === 0) return { groups: [] };
  const degenerate = !(hi > lo);
  const width = degenerate ? 0 : (hi - lo) / bins;
  const key = (isOther: boolean, value: unknown): string =>
    isOther ? '\u0000other' : value === null || value === undefined ? '\u0000null' : String(value);
  const histograms = new Map<string, StudyRow[]>();
  for (const row of histogramRows) {
    const rowKey = key(Boolean(row['is_other']), row['value']);
    const groupRows = histograms.get(rowKey) ?? [];
    groupRows.push(row);
    histograms.set(rowKey, groupRows);
  }
  const build = (row: StudyRow): GroupSummary => {
    const summary = shapeMetricSummary(row);
    const isOther = Boolean(row['is_other']);
    return {
      ...summary,
      value: isOther ? 'other' : jsonValue(group.label(row['value'])),
      histogram: degenerate
        ? { lo, hi, width: 0, counts: [summary.n] }
        : {
            lo,
            hi,
            width,
            counts: densify(histograms.get(key(isOther, row['value'])) ?? [], bins),
          },
    };
  };
  const groups = statRows.filter((row) => !row['is_other']).map(build);
  const other = statRows.find((row) => Boolean(row['is_other']));
  return other === undefined ? { groups } : { groups, other: build(other) };
}
