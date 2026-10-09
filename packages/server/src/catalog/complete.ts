/**
 * The authored catalog completed with the facts only the database knows.
 *
 * See `docs/backend-graph.md`, "Metric catalog". Computed once per `data_version`
 * and cached in memory: it is the first thing the frontend requests and the only
 * response the server caches.
 *
 * The expensive half is the finite-value counts -- 68 metrics across three views.
 * Asking one query per metric would be two hundred scans, so each `(modality, view)`
 * gets a single statement with one `count(*) FILTER (WHERE isfinite(...))` per
 * metric, which DuckDB answers in one pass. The value lists fold the same way: one
 * `UNION ALL` statement per `(modality, view)` covering every categorical field.
 */

import type {
  ByModalityView,
  CompletedCatalog,
  DateRange,
  FieldValueCount,
  Modality,
  NumericRange,
  QuarantineCounts,
  View,
} from '@mriqc/shared';
import { MODALITIES, fieldsFor, getAuthoredCatalog, isNoneValue, metricsFor } from '@mriqc/shared';
import type { Db, Row } from '../db/instance.js';
import { tableFor } from '../db/views.js';
import { quoteIdent, quoteLiteral } from '../sql/filters.js';

/** The most distinct values one field reports, ordered by row count. */
export const MAX_FIELD_VALUES = 200;

/** `meta`, as the build wrote it. */
export interface Meta {
  dataVersion: string;
  builtAt: string;
  /** Which views each modality has, and the policy each was computed under. */
  policies: Partial<Record<Modality, ReadonlyArray<{ view: View; policy: string | null }>>>;
  /**
   * What each modality's policy quarantined, summed over its policy records.
   * Empty for a database built before the build computed the canonical tables,
   * or from the Parquet artifacts, which carry no admission decision per row.
   */
  quarantine: Partial<Record<Modality, QuarantineCounts>>;
}

/** One policy record of `meta.policies`, as `db/build.ts` writes it. */
interface PolicyRecordJson {
  modality?: string;
  /** Null for a Parquet-artifact build, which has no admission decision per row. */
  quarantinedGroups?: number | null;
  quarantinedRows?: number | null;
}

function set<T>(target: ByModalityView<T>, modality: Modality, view: View, value: T): void {
  const byView = target[modality] ?? {};
  byView[view] = value;
  target[modality] = byView;
}

/** Read the single `meta` row. */
export async function readMeta(db: Db): Promise<Meta> {
  const rows = await db.withRead((c) =>
    c.all('SELECT data_version, built_at, policies FROM meta LIMIT 1'),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('meta table is empty: run build:db first');
  const builtAt = row['built_at'];
  const parsed = JSON.parse(String(row['policies'] ?? '{}')) as {
    views?: Meta['policies'];
    policies?: readonly PolicyRecordJson[];
  };
  // One policy per modality today, but summed rather than assigned, so a second
  // policy on one modality would add to its total instead of replacing it.
  const quarantine: Partial<Record<Modality, QuarantineCounts>> = {};
  for (const record of parsed.policies ?? []) {
    const modality = record.modality as Modality | undefined;
    if (modality === undefined) continue;
    // A policy that was loaded rather than computed reports no quarantine, and
    // must not be read as having quarantined nothing.
    if (record.quarantinedGroups === null || record.quarantinedGroups === undefined) continue;
    const current = quarantine[modality] ?? { groups: 0, rows: 0 };
    quarantine[modality] = {
      groups: current.groups + Number(record.quarantinedGroups ?? 0),
      rows: current.rows + Number(record.quarantinedRows ?? 0),
    };
  }
  return {
    dataVersion: String(row['data_version']),
    builtAt: builtAt instanceof Date ? builtAt.toISOString() : String(builtAt),
    policies: parsed.views ?? {},
    quarantine,
  };
}

/** Which normalized columns each modality actually has, from the `columns` table. */
async function readColumns(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db.withRead((c) => c.all('SELECT modality, "column" FROM columns'));
  const byModality = new Map<string, Set<string>>();
  for (const row of rows) {
    const modality = String(row['modality']);
    const columns = byModality.get(modality) ?? new Set<string>();
    columns.add(String(row['column']));
    byModality.set(modality, columns);
  }
  return byModality;
}

/** The DuckDB type of each normalized column, so a value list can be typed back. */
async function readColumnTypes(db: Db): Promise<Map<string, string>> {
  const rows = await db.withRead((c) => c.all('SELECT modality, "column", duck_type FROM columns'));
  const types = new Map<string, string>();
  for (const row of rows) {
    types.set(`${String(row['modality'])}/${String(row['column'])}`, String(row['duck_type']));
  }
  return types;
}

const INTEGER_TYPES = /^(TINY|SMALL|U?BIG|U?HUGE|U?)?INT(EGER)?$|^[US]?(TINY|SMALL|BIG|HUGE)INT$/;

/** Coerce one `VARCHAR`-rendered value back to the type its column holds. */
function coerceValue(text: string | null, duckType: string | undefined): FieldValueCount['value'] {
  if (text === null) return null;
  if (duckType === 'BOOLEAN') return text === 'true';
  if (
    duckType !== undefined &&
    (duckType === 'DOUBLE' ||
      duckType === 'FLOAT' ||
      duckType.startsWith('DECIMAL') ||
      INTEGER_TYPES.test(duckType))
  ) {
    const parsed = Number(text);
    return Number.isNaN(parsed) ? text : parsed;
  }
  return text;
}

/**
 * Fold NULL and the empty string into one entry, carrying `null` as the bucket's
 * value.
 *
 * They are the same thing to anyone reading a filter list -- an option with no
 * label -- and DuckDB reports them separately, so a field that has both offered
 * two blank options. One bucket, counted once; the UI labels it `(none)` and a
 * filter on it matches both (see the server's filter compiler). Re-sorted,
 * because the list's contract is "ordered by count" and the merged count is the
 * sum of two.
 */
function mergeNone(values: readonly FieldValueCount[]): readonly FieldValueCount[] {
  const none = values.filter((entry) => isNoneValue(entry.value));
  if (none.length === 0) return values;
  const merged = [
    ...values.filter((entry) => !isNoneValue(entry.value)),
    { value: null, n: none.reduce((sum, entry) => sum + entry.n, 0) },
  ];
  return merged.sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
}

/**
 * One statement covering every categorical filterable field of a `(modality, view)`.
 * Each branch is its own capped top-N, so a field with millions of distinct values
 * costs one sort, not a cross-field one.
 */
function valueListSql(table: string, fields: readonly string[]): string {
  return fields
    .map(
      (field) =>
        `SELECT ${quoteLiteral(field)} AS field, value, n FROM (` +
        `SELECT CAST(${quoteIdent(field)} AS VARCHAR) AS value, count(*) AS n ` +
        `FROM ${quoteIdent(table)} GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${MAX_FIELD_VALUES})`,
    )
    .join('\nUNION ALL\n');
}

/**
 * One statement bounding every numeric filterable field of a `(modality, view)`.
 *
 * `isfinite` on a DOUBLE cast, not bare `min`/`max`: these columns hold NaN and
 * ±Inf like every other numeric in the dumps (`backend-graph.md`, "Source data"),
 * and an infinite bound as a range control's placeholder is worse than none.
 */
function numericRangeSql(table: string, fields: readonly string[]): string {
  const bounds = fields.flatMap((field) => {
    const value = `CAST(${quoteIdent(field)} AS DOUBLE)`;
    return [
      `min(${value}) FILTER (WHERE isfinite(${value})) AS ${quoteIdent(`${field}__min`)}`,
      `max(${value}) FILTER (WHERE isfinite(${value})) AS ${quoteIdent(`${field}__max`)}`,
    ];
  });
  return `SELECT ${bounds.join(',\n       ')}\nFROM ${quoteIdent(table)}`;
}

/** One statement counting the finite values of every metric of a `(modality, view)`. */
function metricCountSql(table: string, metrics: readonly string[]): string {
  const counts = metrics.map(
    (metric) =>
      `count(*) FILTER (WHERE isfinite(CAST(${quoteIdent(metric)} AS DOUBLE)))` +
      ` AS ${quoteIdent(metric)}`,
  );
  return `SELECT ${counts.join(',\n       ')}\nFROM ${quoteIdent(table)}`;
}

/** Build the completed catalog by querying `db`. Does not consult the cache. */
export async function computeCompletedCatalog(db: Db): Promise<CompletedCatalog> {
  const authored = getAuthoredCatalog();
  const meta = await readMeta(db);
  const present = await readColumns(db);
  const types = await readColumnTypes(db);

  const fieldValues: Record<string, ByModalityView<readonly FieldValueCount[]>> = {};
  const numericRange: Record<string, ByModalityView<NumericRange>> = {};
  const metricCounts: Record<string, ByModalityView<number>> = {};
  const availableViews: Partial<Record<Modality, readonly View[]>> = {};
  const dateRange: Partial<Record<Modality, DateRange | null>> = {};

  for (const modality of MODALITIES) {
    const views = (meta.policies[modality] ?? []).map((entry) => entry.view);
    availableViews[modality] = views;
    const columns = present.get(modality) ?? new Set<string>();

    for (const view of views) {
      const table = tableFor(modality, view);

      const categorical = fieldsFor(modality, view, 'filter')
        .filter((field) => field.kind === 'categorical' && columns.has(field.id))
        .map((field) => field.id as string);
      if (categorical.length > 0) {
        const rows = await db.withRead((c) => c.all(valueListSql(table, categorical)));
        const grouped = new Map<string, FieldValueCount[]>();
        for (const row of rows) {
          const field = String(row['field']);
          const value = row['value'];
          const list = grouped.get(field) ?? [];
          list.push({
            value: coerceValue(
              value === null || value === undefined ? null : String(value),
              types.get(`${modality}/${field}`),
            ),
            n: Number(row['n']),
          });
          grouped.set(field, list);
        }
        for (const field of categorical) {
          fieldValues[field] ??= {};
          set(fieldValues[field], modality, view, mergeNone(grouped.get(field) ?? []));
        }
      }

      const numeric = fieldsFor(modality, view, 'filter')
        .filter((field) => field.kind === 'numeric' && columns.has(field.id))
        .map((field) => field.id as string);
      if (numeric.length > 0) {
        const rows: Row[] = await db.withRead((c) => c.all(numericRangeSql(table, numeric)));
        const row = rows[0] ?? {};
        for (const field of numeric) {
          const min = Number(row[`${field}__min`]);
          const max = Number(row[`${field}__max`]);
          // No finite value in this table means no range, not a range of NaN:
          // the UI must be able to tell "unknown" from "a real bound".
          if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
          numericRange[field] ??= {};
          set(numericRange[field], modality, view, { min, max });
        }
      }

      const metrics = metricsFor(modality)
        .filter((metric) => columns.has(metric.id))
        .map((metric) => metric.id as string);
      if (metrics.length > 0) {
        const rows: Row[] = await db.withRead((c) => c.all(metricCountSql(table, metrics)));
        const row = rows[0] ?? {};
        for (const metric of metrics) {
          metricCounts[metric] ??= {};
          set(metricCounts[metric], modality, view, Number(row[metric] ?? 0));
        }
      }
    }

    if (views.includes('raw')) {
      const rows = await db.withRead((c) =>
        c.all(`SELECT min(created_at) AS lo, max(created_at) AS hi FROM ${tableFor(modality, 'raw')}`),
      );
      const lo = rows[0]?.['lo'];
      const hi = rows[0]?.['hi'];
      dateRange[modality] =
        lo instanceof Date && hi instanceof Date
          ? { min: lo.toISOString(), max: hi.toISOString() }
          : null;
    }
  }

  return {
    ...authored,
    fieldValues,
    numericRange,
    metricCounts,
    availableViews,
    quarantine: meta.quarantine,
    dateRange,
    dataVersion: meta.dataVersion,
  };
}

/**
 * One cached catalog per database handle, held as the in-flight promise rather
 * than the resolved value.
 *
 * The catalog is the first request of every dashboard load, so a cold start or a
 * post-ingest invalidation arrives as a burst of concurrent misses. Caching the
 * promise is what makes the burst share one computation instead of each caller
 * running the same fifteen scans over millions of rows and then overwriting the
 * others' result.
 *
 * Nothing re-reads `meta` on a hit either: `publishDataVersion` calls
 * {@link invalidateCatalog} whenever the version moves in this process, and a
 * rebuild underneath a running server needs a restart regardless (see
 * `docs/backend-graph.md`, "Ingest").
 */
const cached = new WeakMap<Db, Promise<CompletedCatalog>>();

/**
 * The completed catalog for `db`, computed once per `data_version` and shared by
 * every concurrent caller.
 */
export async function getCompletedCatalog(db: Db): Promise<CompletedCatalog> {
  const hit = cached.get(db);
  if (hit !== undefined) return hit;
  const pending = computeCompletedCatalog(db);
  cached.set(db, pending);
  // A failed computation must not be cached: the next request should retry.
  pending.catch(() => {
    if (cached.get(db) === pending) cached.delete(db);
  });
  return pending;
}

/** Drop the cached catalog for `db`. Ingest calls this after it bumps the version. */
export function invalidateCatalog(db: Db): void {
  cached.delete(db);
}
