/**
 * The pure core of the filter compiler: operator to SQL fragment, parameter
 * order, the `(none)` expansion, and the brushed selection.
 *
 * It lives in the shared package because two runners need the same fragments.
 * The server compiles against a catalog-validated view (`sql/filters.ts` supplies
 * the validation this module calls back into), and the dashboard's DuckDB-WASM
 * runner compiles the same `Filter[]` against an uploaded study's single table,
 * where the catalog's per-view allowlist does not apply -- the study has whatever
 * columns its file had. See `docs/comparison-design.md`, "Query model", and
 * `docs/backend-graph.md`, "Query templates and the filter compiler".
 *
 * What stays with the caller is *which* columns exist and are filterable; what is
 * here is how a filter becomes SQL. The function is pure: no database, no module
 * state, so it can be unit-tested exhaustively.
 */

import type { FieldKind, Filter, FilterValue, Selection, SelectionScope } from '../types.js';
import { NONE_FILTER_VALUE } from '../types.js';

/** The most values one `in` filter may carry. */
export const MAX_IN_VALUES = 500;

export const MAX_SELECTIONS = 4;

/** Normalize the legacy alias without silently dropping either representation. */
export function normalizeSelections(scope: SelectionScope): readonly Selection[] {
  if (scope.selections !== undefined && scope.selection != null) {
    throw new FilterError('use selections or selection, not both');
  }
  const selections = scope.selections ?? (scope.selection == null ? [] : [scope.selection]);
  if (selections.length > MAX_SELECTIONS) {
    throw new FilterError(`selections may contain at most ${MAX_SELECTIONS} entries`);
  }
  if (new Set(selections.map((s) => s.metric)).size !== selections.length) {
    throw new FilterError('selection metrics must be distinct');
  }
  return selections;
}

/** A compiled predicate fragment and the parameters it binds, in order. */
export interface CompiledFilters {
  /** Always starts with `TRUE`; safe to append to any template's `WHERE`. */
  where: string;
  params: FilterValue[];
}

/** Thrown for any filter the compiler refuses. The message is safe to return to a client. */
export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

/** Quote an identifier for DuckDB, doubling any embedded quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A calendar date, optionally with a time: what a date bound and a keyset cursor
 * may be. Anything else would reach DuckDB as a `CAST(... AS TIMESTAMP)` and come
 * back as a Conversion Error -- a 500 for what is plainly a bad request, with the
 * column name and the offending value quoted back to the client.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** True when `value` is a date or timestamp DuckDB will certainly accept. */
export function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Which operators each field kind accepts.
 *
 * `between` on a categorical field is the rejection the design calls out by name:
 * a lexicographic range over manufacturer names is never what anyone meant. `in`
 * on a date is rejected for the same reason -- an exact-timestamp set is not a
 * date filter -- so a date is filtered by range or nullity only.
 */
export const ALLOWED_OPS: Readonly<Record<FieldKind, readonly Filter['op'][]>> = {
  categorical: ['in', 'isNull', 'notNull'],
  numeric: ['in', 'between', 'isNull', 'notNull'],
  date: ['between', 'isNull', 'notNull'],
};

/** All the core needs to know about one column: what to quote, and how it behaves. */
export interface FilterColumn {
  id: string;
  kind: FieldKind;
}

/**
 * The caller's answer to "does this column exist, and may it be filtered here?".
 *
 * Both members throw -- a {@link FilterError} -- rather than returning null, so
 * the refusal carries the caller's own wording: the server names the modality and
 * the view, the study runner names the uploaded file.
 */
export interface FilterValidator {
  /** The column a filter's field id compiles against, or a refusal. */
  field(fieldId: string): FilterColumn;
  /** The column a selection's metric id brushes on, or a refusal. */
  metric(metricId: string): string;
}

function compileOne(filter: Filter, field: FilterColumn, params: FilterValue[]): string {
  const allowed = ALLOWED_OPS[field.kind];
  if (!allowed.includes(filter.op)) {
    throw new FilterError(
      `operator "${filter.op}" is not allowed on ${field.kind} field "${field.id}"` +
        ` (allowed: ${allowed.join(', ')})`,
    );
  }

  const column = quoteIdent(field.id);
  switch (filter.op) {
    case 'in': {
      const values = filter.values;
      if (values.length === 0) {
        throw new FilterError(`filter on "${field.id}" has an empty "in" list`);
      }
      if (values.length > MAX_IN_VALUES) {
        throw new FilterError(
          `filter on "${field.id}" has ${values.length} values, over the ${MAX_IN_VALUES} limit`,
        );
      }
      // A numeric column binds numbers. A categorical one may be backed by any of
      // VARCHAR, DOUBLE or BOOLEAN -- `magnetic_field_strength` is a DOUBLE served
      // as a value list -- and the authored catalog does not carry the DuckDB type,
      // so those values stay as they came and a bad one is caught as a conversion
      // error and mapped to BAD_REQUEST rather than refused here.
      // The empty string is the `(none)` bucket, not a value: the completed
      // catalog merges NULL and '' into one option, so a filter that picks it has
      // to match both. The cast is what keeps the `= ''` arm safe on a column
      // that is not VARCHAR -- `magnetic_field_strength` is a DOUBLE served as a
      // value list, and comparing it to '' directly is a conversion error.
      const wantsNone = values.some((value) => value === NONE_FILTER_VALUE);
      const named = values.filter((value) => value !== NONE_FILTER_VALUE);

      if (field.kind === 'numeric') {
        for (const value of named) {
          if (typeof value !== 'number' || !isFinite(value)) {
            throw new FilterError(
              `filter on numeric field "${field.id}" needs finite number values`,
            );
          }
        }
      }

      const arms: string[] = [];
      if (named.length > 0) {
        params.push(...named);
        arms.push(`${column} IN (${named.map(() => '?').join(', ')})`);
      }
      if (wantsNone) arms.push(`${column} IS NULL OR CAST(${column} AS VARCHAR) = ''`);
      return `(${arms.join(' OR ')})`;
    }
    case 'between': {
      const { lo, hi } = filter;
      if (field.kind === 'date') {
        if (!isIsoDateString(lo) || !isIsoDateString(hi)) {
          throw new FilterError(`date filter on "${field.id}" needs ISO-8601 string bounds`);
        }
        params.push(lo, hi);
        return `${column} BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)`;
      }
      if (typeof lo !== 'number' || typeof hi !== 'number' || !isFinite(lo) || !isFinite(hi)) {
        throw new FilterError(`numeric filter on "${field.id}" needs two finite number bounds`);
      }
      if (lo > hi) throw new FilterError(`filter on "${field.id}" has lo greater than hi`);
      params.push(lo, hi);
      return `${column} BETWEEN ? AND ?`;
    }
    case 'isNull':
      return `${column} IS NULL`;
    case 'notNull':
      return `${column} IS NOT NULL`;
  }
}

function compileSelection(
  selection: Selection,
  validate: FilterValidator,
  params: FilterValue[],
): string {
  const metric = validate.metric(selection.metric);
  const [lo, hi] = selection.range;
  if (typeof lo !== 'number' || typeof hi !== 'number' || !isFinite(lo) || !isFinite(hi)) {
    throw new FilterError(`selection on "${selection.metric}" needs a finite range`);
  }
  if (lo > hi) throw new FilterError(`selection on "${selection.metric}" has lo greater than hi`);
  // Metrics are not all DOUBLE -- the geometry metrics are counts, and so BIGINT --
  // and `isfinite` is a floating-point predicate, so the cast is what makes one
  // expression work for every metric.
  const column = `CAST(${quoteIdent(metric)} AS DOUBLE)`;
  params.push(lo, hi);
  // A brush is a range on a chart, and a chart only ever drew finite values.
  return `isfinite(${column}) AND ${column} BETWEEN ? AND ?`;
}

/**
 * Compile filters and the linked selection into one predicate fragment, asking
 * `validate` which columns are admissible.
 *
 * The result always begins with `TRUE`, so `WHERE ${where}` is valid even with no
 * filters at all, and every value is bound positionally in `params` order.
 */
export function compileFiltersCore(
  filters: readonly Filter[],
  selections: readonly Selection[] | Selection | null | undefined,
  validate: FilterValidator,
): CompiledFilters {
  const params: FilterValue[] = [];
  const fragments: string[] = ['TRUE'];

  for (const filter of filters) {
    fragments.push(compileOne(filter, validate.field(filter.field), params));
  }

  // Keep the positional single-selection form for existing study runners.
  const list = normalizeSelections(Array.isArray(selections)
    ? { selections }
    : { selection: (selections ?? null) as Selection | null });
  for (const selection of list) {
    fragments.push(compileSelection(selection, validate, params));
  }

  return { where: fragments.join(' AND '), params };
}
