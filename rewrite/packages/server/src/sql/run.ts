/**
 * Template loading, identifier validation, parameter binding and timeouts.
 *
 * See `docs/backend-graph.md`, "Query templates and the filter compiler": a
 * template has three kinds of holes. The target table comes from the view map, a
 * column identifier must be an id the catalog marks valid for its role and is
 * quoted, and every value is a positional parameter. Nothing else may be
 * substituted, which {@link fill} enforces by refusing a template that still has
 * an unfilled hole.
 */

import type {
  ColumnId,
  FieldDef,
  Granularity,
  Modality,
  TemplateName,
  View,
} from '@mriqc/shared';
import {
  asColumnId,
  exportableColumnsFor,
  fieldsFor,
  isValidField,
  isValidMetric,
  parseStatements,
  statementsOf,
} from '@mriqc/shared';
import { QUERY_TIMEOUT_MS } from '../config.js';
import type { Db, ParamValue, ReadOptions, Row } from '../db/instance.js';
import { quoteIdent } from './filters.js';

export { quoteIdent };

/**
 * Re-exported for the callers that split a SQL text themselves -- `db/canonical.ts`
 * reads the policy SQL, which is server-only and still a file on disk.
 */
export { parseStatements };
export type { TemplateName };

/** Thrown for any identifier or enum the catalog does not admit. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/* -------------------------------------------------------------- templates */

/**
 * The named statement of one template.
 *
 * The texts come from `@mriqc/shared` rather than from `.sql` files beside this
 * module: the browser's DuckDB-WASM runner compiles the same statements for an
 * uploaded study and has no filesystem to read them from, so one source of truth
 * means one string constant. The splitting is cached in shared.
 */
export function loadTemplate(name: TemplateName, statement: string): string {
  const sql = statementsOf(name).get(statement);
  if (sql === undefined) throw new TemplateError(`the ${name} template has no statement "${statement}"`);
  return sql;
}

/**
 * Substitute every `{{hole}}`. Each value must already be a quoted identifier, a
 * literal from an allowlist, or a compiled fragment; a hole left unfilled is a
 * programming error and throws rather than reaching DuckDB.
 */
export function fill(sql: string, holes: Readonly<Record<string, string>>): string {
  const filled = sql.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = holes[key];
    if (value === undefined) throw new TemplateError(`no value for template hole {{${key}}}`);
    return value;
  });
  const leftover = /\{\{(\w+)\}\}/.exec(filled);
  if (leftover !== null) throw new TemplateError(`unfilled template hole ${leftover[0]}`);
  return filled;
}

/* ------------------------------------------------------------- identifiers */

/**
 * The expression a metric is read through.
 *
 * Not every metric is DOUBLE -- the geometry metrics are voxel counts, so BIGINT --
 * and `isfinite`, `quantile_cont` and the histogram arithmetic all want a float,
 * so one cast in one place keeps the templates uniform.
 */
export function metricExpr(modality: Modality, metricId: string): string {
  if (!isValidMetric(modality, metricId)) {
    throw new TemplateError(`unknown metric "${metricId}" for modality ${modality}`);
  }
  return `CAST(${quoteIdent(metricId)} AS DOUBLE)`;
}

/** The catalog's definition of a group field, or a refusal. */
export function groupField(modality: Modality, view: View, fieldId: string): FieldDef {
  if (!isValidField(modality, view, fieldId, 'group')) {
    throw new TemplateError(`"${fieldId}" is not a group field for ${modality}/${view}`);
  }
  return fieldsFor(modality, view, 'group').find((f) => f.id === fieldId) as FieldDef;
}

/** How many equal-width bins a numeric group column is split into. */
export const NUMERIC_GROUP_BINS = 10;

/** The most groups `groupedSummary` reports before folding the rest into `other`. */
export const MAX_GROUPS = 50;

/** Bins in a grouped summary's per-group histograms. */
export const GROUPED_HISTOGRAM_BINS = 30;

/** The raw value expression of a group column: a plain cast, never a label. */
export function groupValueExpr(field: FieldDef): string {
  return field.kind === 'numeric'
    ? `CAST(${quoteIdent(field.id)} AS DOUBLE)`
    : `CAST(${quoteIdent(field.id)} AS VARCHAR)`;
}

/**
 * Decimals a bin label needs before two adjacent edges stop rendering the same
 * text. A fixed four was the old choice and it merged bins whenever the width fell
 * below ~1e-4 -- `echo_time` or `spacing_*` under a narrowing filter -- silently
 * reporting fewer than {@link NUMERIC_GROUP_BINS} groups with overlapping bounds.
 */
export function binLabelDecimals(width: number): number {
  if (!(width > 0) || !isFinite(width)) return 4;
  return Math.min(15, Math.max(4, Math.ceil(-Math.log10(width)) + 2));
}

/** One bin's `"lo–hi"` label, with enough precision to stay distinct from its neighbours. */
export function binLabel(lo: number, width: number, index: number): string {
  const decimals = binLabelDecimals(width);
  const edge = (offset: number): string => String(Number((lo + width * (index + offset)).toFixed(decimals)));
  return `${edge(0)}–${edge(1)}`;
}

/** The expression a group is formed by, and how one grouped value becomes a label. */
export interface GroupExpr {
  /** Substituted into `{{group_expr}}`; what `GROUP BY` and the window functions see. */
  expr: string;
  params: ParamValue[];
  /** The value the client is shown for one group key. */
  label(value: unknown): unknown;
}

/**
 * The expression a group is formed by.
 *
 * A categorical or date column groups by its own value. A numeric column would
 * otherwise produce one group per distinct float, so it is split into
 * {@link NUMERIC_GROUP_BINS} equal-width bins over `[lo, hi]`. The grouping key is
 * the *bin index*, never the rendered label: labelling in SQL meant grouping by
 * rounded text, which merged adjacent bins as soon as the width fell below the
 * rounding. The label is formatted from the index afterwards, in JS.
 */
export function groupExpr(
  field: FieldDef,
  bounds: { lo: number; width: number } | null,
): GroupExpr {
  const identity = (value: unknown): unknown => value;
  if (field.kind !== 'numeric') return { expr: groupValueExpr(field), params: [], label: identity };
  if (bounds === null || !(bounds.width > 0)) {
    // A degenerate range (no rows, or one distinct value) has nothing to bin.
    return { expr: groupValueExpr(field) + '::VARCHAR', params: [], label: identity };
  }
  const { lo, width } = bounds;
  const value = `CAST(${quoteIdent(field.id)} AS DOUBLE)`;
  const index =
    `least(${NUMERIC_GROUP_BINS - 1}, greatest(0,` +
    ` CAST(floor((${value} - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) AS BIGINT)))`;
  const expr =
    `CASE WHEN ${value} IS NULL OR NOT isfinite(${value}) THEN NULL ELSE ${index} END`;
  return {
    expr,
    params: [lo, width],
    label: (raw) =>
      raw === null || raw === undefined ? null : binLabel(lo, width, Number(raw)),
  };
}

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month', 'year'];

/** A `date_trunc` unit as a SQL literal, from the allowlist only. */
export function granularityLiteral(granularity: string): string {
  if (!GRANULARITIES.includes(granularity as Granularity)) {
    throw new TemplateError(`unknown granularity "${granularity}"`);
  }
  return `'${granularity}'`;
}

/** Columns the keyset order needs, and so every `sample` and `export` row carries. */
export const KEYSET_COLUMNS: readonly ColumnId[] = [asColumnId('created_at'), asColumnId('id')];

/**
 * Validate a requested column list against the export allowlist and return it with
 * the keyset columns in front, deduplicated. An unknown column is a refusal, not a
 * silent drop.
 */
export function projectionColumns(
  modality: Modality,
  view: View,
  requested: readonly string[],
): ColumnId[] {
  const allowed = new Set<string>(exportableColumnsFor(modality, view));
  for (const column of requested) {
    if (!allowed.has(column)) {
      throw new TemplateError(`"${column}" is not an exportable column for ${modality}/${view}`);
    }
  }
  return [...new Set<string>([...KEYSET_COLUMNS, ...requested])].map(asColumnId);
}

/** The quoted `SELECT` list for a validated projection. */
export function projectionSql(columns: readonly ColumnId[]): string {
  return columns.map((c) => quoteIdent(c)).join(', ');
}

/* ------------------------------------------------------------------ cursor */

/**
 * The keyset position a `sample` page resumes from.
 *
 * `created_at` is a microsecond TIMESTAMP, so the position is carried as epoch
 * microseconds rather than as an ISO string: a JS `Date` only has milliseconds,
 * and a boundary row with non-zero microseconds would have made the next page's
 * predicate skip every row in the rest of that millisecond.
 */
export interface Cursor {
  /** `created_at` of the last row of the previous page, in epoch microseconds. */
  createdAtUs: bigint;
  /** `id` of that row, breaking ties within one timestamp. */
  id: string;
}

/** The extra column `sample`'s page statement projects so a cursor can be built. */
export const CURSOR_US_COLUMN = '__created_us';

/** The cursor pointing at one row of a `sample` page, or null if that row has no position. */
export function cursorFromRow(row: Row): Cursor | null {
  const us = row[CURSOR_US_COLUMN];
  const id = row['id'];
  if (us === null || us === undefined || id === null || id === undefined) return null;
  try {
    return { createdAtUs: BigInt(String(us)), id: String(id) };
  } catch {
    return null;
  }
}

/** Encode a cursor as base64 JSON, opaque to the client. */
export function encodeCursor(cursor: Cursor): string {
  const payload = { us: cursor.createdAtUs.toString(), id: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode a cursor, refusing anything that is not one this server produced. */
export function decodeCursor(encoded: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new TemplateError('cursor is not valid base64 JSON');
  }
  const record = parsed as { us?: unknown; id?: unknown };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof record.us !== 'string' ||
    !/^-?\d{1,19}$/.test(record.us) ||
    typeof record.id !== 'string'
  ) {
    throw new TemplateError('cursor is missing a valid position or id');
  }
  return { createdAtUs: BigInt(record.us), id: record.id };
}

/**
 * The keyset predicate for a cursor, or `TRUE` for the first page. Written as two
 * comparisons rather than a row comparison so the plan stays an index-free scan
 * with a plain filter on every DuckDB version, and against `epoch_us(created_at)`
 * so the comparison keeps the column's own microsecond resolution.
 */
export function cursorPredicate(cursor: Cursor | null): { sql: string; params: ParamValue[] } {
  if (cursor === null) return { sql: 'TRUE', params: [] };
  return {
    sql:
      '(epoch_us(created_at) < CAST(? AS BIGINT)' +
      ' OR (epoch_us(created_at) = CAST(? AS BIGINT) AND id < ?))',
    params: [cursor.createdAtUs, cursor.createdAtUs, cursor.id],
  };
}

/* ------------------------------------------------------------------ running */

/** Run one filled statement on a pooled read connection, under the query timeout. */
export async function runSql(
  db: Db,
  sql: string,
  params: readonly ParamValue[],
  options: number | ReadOptions = QUERY_TIMEOUT_MS,
): Promise<Row[]> {
  return db.withRead((connection) => connection.all(sql, params), options);
}
