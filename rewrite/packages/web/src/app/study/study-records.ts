import { getAuthoredCatalog, quoteIdent, type CoverageResult, type SampleResult, type SampleRow } from '@mriqc/shared';
import type { StudyCoverageQuery, StudySampleQuery } from '../api/api';
import { compileStudyStatement, predicate, studyGroupExpression, type StudyRow } from './study-sql';

export const STUDY_PAGE_SIZE = 100;

/** Adapt local records to the shared templates' ordering/time columns. The
 * synthetic time is only an internal key: never exposed as an upload date.
 * Predicates run on original columns before the adapter is applied. */
function recordTable(columns: ReadonlySet<string>, where: string, countsOnly: boolean): string {
  const projection = [...columns].filter(column => column !== 'created_at' && column !== 'id').map(quoteIdent);
  const time = columns.has('created_at') ? quoteIdent('created_at') : 'NULL::TIMESTAMP';
  return `(SELECT ${projection.join(', ')}, CAST(rowid AS VARCHAR) AS id, ${time} AS __study_upload_time, ` +
    `${countsOnly ? "TIMESTAMP '2000-01-01'" : `coalesce(${time}, TIMESTAMP '0001-01-01')`} AS created_at ` +
    `FROM ${quoteIdent('study')} WHERE ${where})`;
}

export function compileStudyCoverage(query: StudyCoverageQuery, columns: ReadonlySet<string>) {
  if (!['day', 'week', 'month', 'year'].includes(query.granularity)) throw new Error('Invalid calendar granularity');
  if (!query.countsOnly && !columns.has('created_at')) throw new Error('your file has no upload time');
  const compiled = predicate(query, columns);
  // Upload-time totals need no arbitrary categorical column. created_at is the
  // ungrouped sentinel; categorical cards request the actual category column.
  const field = query.group === 'created_at' ? null : getAuthoredCatalog().fields.find(field =>
    field.id === query.group && field.groupable && field.modalities.includes(query.modality));
  if (query.group !== 'created_at' && (!field || !columns.has(query.group))) throw new Error(`The uploaded study has no column "${query.group}"`);
  const table = query.countsOnly ? recordTable(columns, compiled.where, true) : quoteIdent('study');
  const common = { table, where: query.countsOnly ? 'TRUE' : compiled.where, granularity: `'${query.granularity}'` };
  const range = field?.kind === 'numeric' ? compileStudyStatement('coverage', 'group_range', {
    ...common, group_expr: `CAST(${quoteIdent(field.id)} AS DOUBLE)`,
  }, compiled.params) : null;
  return {
    range,
    buckets(bounds: { lo: number; width: number } | null) {
      const group = field ? studyGroupExpression(field, bounds) : { expr: 'NULL', params: [], label: (value: unknown) => value };
      return { group, statement: compileStudyStatement('coverage', 'buckets', { ...common, group_expr: group.expr },
        [...group.params, ...compiled.params]) };
    },
  };
}

export function shapeStudyCoverage(rows: readonly StudyRow[], label: (value: unknown) => unknown): CoverageResult {
  return { buckets: rows.map(row => ({
    start: new Date(row['bucket'] as number | string).toISOString().slice(0, 10),
    group: label(row['value']) as string | number | boolean | null,
    n: Number(row['n']),
  })) };
}

export function compileStudySample(query: StudySampleQuery, columns: ReadonlySet<string>) {
  const compiled = predicate(query, columns);
  const requested = [...new Set([...query.columns, 'id', 'created_at'])];
  for (const column of requested) {
    if (column !== 'id' && column !== 'created_at' && !columns.has(column)) throw new Error(`The uploaded study has no column "${column}"`);
  }
  let cursor = 'TRUE';
  const params = [...compiled.params];
  if (query.cursor !== null) {
    const value: unknown = JSON.parse(query.cursor);
    if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'string') || !/^-?\d+$/.test(value[0])) throw new Error('Invalid study cursor');
    cursor = '(created_at, id) < (make_timestamp(CAST(? AS BIGINT)), CAST(? AS VARCHAR))';
    params.push(value[0], value[1]);
  }
  params.push(STUDY_PAGE_SIZE + 1);
  return compileStudyStatement('sample', 'page', {
    table: recordTable(columns, compiled.where, false), where: 'TRUE', cursor,
    columns: [...requested.map(quoteIdent), '__study_upload_time'].join(', '),
  }, params);
}

export function shapeStudySample(rows: readonly StudyRow[]): SampleResult {
  const page = rows.slice(0, STUDY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    rows: page.map(row => {
      const { __created_us: _, __study_upload_time: time, ...values } = row;
      return { ...values, created_at: time == null ? null : new Date(time as number | string).toISOString() } as SampleRow;
    }),
    nextCursor: rows.length > STUDY_PAGE_SIZE && last ? JSON.stringify([String(last['__created_us']), String(last['id'])]) : null,
  };
}
