/**
 * The query union the dashboard's `datasets` map is keyed by, and its canonical
 * serialization. See `docs/dashboard-graph.md`, "Query keys and procedures":
 * two panels with the same parameters must share one entry, so the key has to be
 * a pure function of the query's meaning, not of how the object was built.
 */

import type {
  ClipMode,
  ColumnId,
  Filter,
  FilterValue,
  Granularity,
  Modality,
  Selection,
  SelectionScope,
  View,
} from './types.js';
import { normalizeSelections } from './sql/filters-core.js';

/** A canonical query serialization. Opaque; only `queryKey` produces one. */
export type QueryKey = string;

/** Population data comes from the server, study data from the DuckDB-WASM instance. */
export type QuerySource = 'population' | 'study';

/** Parameters every data query carries. */
interface Scoped extends SelectionScope {
  modality: Modality;
  view: View;
  filters: readonly Filter[];
}

/** Additive query type until the web dispatcher supports the new panel. */
export interface TimeSummaryQuery extends Scoped {
  source: QuerySource;
  proc: 'timeSummary';
  metric: ColumnId;
  granularity: Granularity;
  group?: ColumnId;
  /** Inclusive created_at bounds; filtering precedes bucketing. */
  window?: [string, string];
}

/** One fetchable question. Each variant maps to one tRPC procedure. */
export type Query =
  | ({
      source: QuerySource;
      proc: 'distribution';
      metric: ColumnId;
      bins: number;
      /**
       * The x range the histogram is computed over. A server parameter, not a
       * display setting: `distribution` bins between the quantiles this names,
       * so changing it changes the counts and therefore the key.
       */
      clip: ClipMode;
      /**
       * An explicit `[lo, hi]` the histogram is binned over, overriding `clip`.
       *
       * What a comparison panel sends: every cohort of one panel asks for the
       * same range, so the overlaid bars share bin edges (`docs/comparison-design.md`,
       * "Comparison panel"). Part of the key, because when the shared range moves
       * -- a cohort's p01 or p99 changed -- the counts change and the histograms
       * have to be refetched. Absent for a plain distribution panel.
       */
      range?: [number, number];
    } & Scoped)
  | ({ source: QuerySource; proc: 'groupedSummary'; metric: ColumnId; group: ColumnId } & Scoped)
  | ({
      source: 'population';
      proc: 'coverage';
      group: ColumnId;
      granularity: Granularity;
    } & Scoped)
  | ({
      source: 'population';
      proc: 'sample';
      columns: readonly ColumnId[];
      cursor: string | null;
    } & Scoped)
  | ({
      source: QuerySource;
      proc: 'density2d';
      x: ColumnId;
      y: ColumnId;
      bins: number;
      clip: ClipMode;
      range?: { x: [number, number]; y: [number, number] };
      sampleSize: number;
      seed?: number;
    } & Scoped)
  | ({
      source: QuerySource;
      proc: 'correlation';
      metrics: readonly ColumnId[];
      method: 'pearson' | 'spearman' | 'both';
    } & Scoped)
  | { source: 'population'; proc: 'catalog' };

/**
 * A stable decimal rendering. `String(n)` is already the shortest round-tripping
 * form for a JS double; the special cases only exist so `-0`, `NaN` and the
 * infinities serialize as themselves instead of colliding or reading as `null`.
 */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/** Tag scalars by type so the string `"1"` and the number `1` cannot collide. */
function formatScalar(value: FilterValue): string {
  if (typeof value === 'number') return `n:${formatNumber(value)}`;
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  return `s:${encodeURIComponent(value)}`;
}

function formatBound(value: number | string): string {
  return typeof value === 'number' ? `n:${formatNumber(value)}` : `s:${encodeURIComponent(value)}`;
}

function formatFilter(filter: Filter): string {
  const field = encodeURIComponent(filter.field);
  switch (filter.op) {
    case 'in':
      // Membership is a set: sort the values so argument order cannot change the key.
      return `${field}~in~${[...filter.values].map(formatScalar).sort().join(',')}`;
    case 'between':
      return `${field}~between~${formatBound(filter.lo)}..${formatBound(filter.hi)}`;
    default:
      return `${field}~${filter.op}`;
  }
}

/**
 * Filters are a conjunction, so their order is meaningless: sort the rendered
 * fragments, which orders by field, then op, then values, since each fragment
 * starts with the field name.
 */
function formatFilters(filters: readonly Filter[]): string {
  return filters.map(formatFilter).sort().join(';');
}

/** An explicit histogram range, in the same `lo..hi` shape a selection renders. */
function formatRange(range: readonly [number, number]): string {
  return `${formatNumber(range[0])}..${formatNumber(range[1])}`;
}

function formatDensity2dRange(range: {
  x: readonly [number, number];
  y: readonly [number, number];
}): string {
  return `x:${formatRange(range.x)};y:${formatRange(range.y)}`;
}

function formatSelection(selection: Selection): string {
  const [lo, hi] = selection.range;
  return `${encodeURIComponent(selection.metric)}~${formatNumber(lo)}..${formatNumber(hi)}`;
}

type Params = ReadonlyArray<readonly [name: string, value: string]>;

/** Render `name=value` pairs sorted by name, dropping empties so absent and empty agree. */
function render(source: QuerySource, proc: string, params: Params): QueryKey {
  const rendered = params
    .filter(([, value]) => value !== '')
    .map(([name, value]) => [name, value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return rendered === '' ? `${source}/${proc}` : `${source}/${proc}?${rendered}`;
}

/** The scoping parameters every data query shares. */
function scopeParams(query: Scoped): Params {
  return [
    ['m', query.modality],
    ['v', query.view],
    ['f', formatFilters(query.filters)],
    ['sel', [...normalizeSelections(query)]
      .sort((a, b) => a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)
      .map(formatSelection).join(';')],
  ];
}

/**
 * The canonical key for a query. Deterministic: two queries that mean the same
 * thing produce the same string regardless of property order, filter order, or
 * the order of values inside an `in` filter. Any difference that changes the
 * result -- a different metric, bin count, granularity or cursor -- changes it.
 */
export function queryKey(query: Query | TimeSummaryQuery): QueryKey {
  switch (query.proc) {
    case 'catalog':
      return render(query.source, 'catalog', []);
    case 'timeSummary':
      return render(query.source, 'timeSummary', [
        ...scopeParams(query),
        ['metric', encodeURIComponent(query.metric)],
        ['gran', query.granularity],
        ['group', query.group === undefined ? '' : encodeURIComponent(query.group)],
        ['window', query.window?.map(encodeURIComponent).join('..') ?? ''],
      ]);
    case 'distribution':
      return render(query.source, 'distribution', [
        ...scopeParams(query),
        ['metric', encodeURIComponent(query.metric)],
        ['bins', formatNumber(query.bins)],
        ['clip', query.clip],
        // Empty when absent, and `render` drops empties, so a plain distribution
        // panel's key is exactly what it was before the field existed.
        ['range', query.range === undefined ? '' : formatRange(query.range)],
      ]);
    case 'groupedSummary':
      return render(query.source, 'groupedSummary', [
        ...scopeParams(query),
        ['metric', encodeURIComponent(query.metric)],
        ['group', encodeURIComponent(query.group)],
      ]);
    case 'coverage':
      return render(query.source, 'coverage', [
        ...scopeParams(query),
        ['group', encodeURIComponent(query.group)],
        ['gran', query.granularity],
      ]);
    case 'sample':
      return render(query.source, 'sample', [
        ...scopeParams(query),
        // Column order does not change which rows come back, only their shape,
        // but it does change the response, so it is part of the key as given.
        ['cols', query.columns.map((c) => encodeURIComponent(c)).join(',')],
        ['cursor', query.cursor === null ? '' : encodeURIComponent(query.cursor)],
      ]);
    case 'density2d':
      return render(query.source, 'density2d', [
        ...scopeParams(query),
        ['x', encodeURIComponent(query.x)],
        ['y', encodeURIComponent(query.y)],
        ['bins', formatNumber(query.bins)],
        ['clip', query.clip],
        ['range', query.range === undefined ? '' : formatDensity2dRange(query.range)],
        ['sampleSize', formatNumber(query.sampleSize)],
        ['seed', formatNumber(query.seed ?? 1)],
      ]);
    case 'correlation':
      return render(query.source, 'correlation', [
        ...scopeParams(query),
        // Metric order is meaningful in the response matrices, so preserve it.
        ['metrics', query.metrics.map((metric) => encodeURIComponent(metric)).join(',')],
        ['method', query.method],
      ]);
  }
}
