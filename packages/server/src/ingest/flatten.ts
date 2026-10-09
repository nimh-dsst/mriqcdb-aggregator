/**
 * MongoDB extended JSON to the serving tables' own columns.
 *
 * See `docs/backend-graph.md`, "Ingest from dumps (decided 2026-10-08)": a dump
 * file (or a Mongo page serialized the same way) is staged with `read_json` and
 * flattened "with the same rules the Parquet conversion used". Those rules are
 * written down in `C:/Users/licc/projects/mriqc/KEY.md` and implemented, per
 * modality, in that directory's `convert_<modality>.sql`:
 *
 * - every leaf becomes its own column, nested objects flattened with **dot
 *   notation** (`bids_meta.EchoTime`, `provenance.settings.fd_thres`);
 * - the three MongoDB wrappers are unwrapped: `_id.$oid`, `_created.$date`,
 *   `_updated.$date`;
 * - an extended-JSON scalar wrapper (`{"$numberDouble": "NaN"}` and the
 *   `$numberInt`/`$numberLong`/`$numberDecimal` siblings) is unwrapped to its
 *   string and cast, so a computed NaN or ±Infinity survives as IEEE NaN / ±Inf
 *   rather than becoming NULL -- absent, NaN and Inf stay three distinct states;
 * - a genuine array or object value keeps its **JSON text verbatim** in a VARCHAR.
 *
 * The staging is three relations rather than one expression per column, because
 * the unwrap has to be spelled out once per column either way and nesting it
 * inside a cast inside a `CASE` three times over produces a megabyte of SQL for
 * T1w's 176 columns:
 *
 * 1. `jsonSelect` extracts each dotted source path as a JSON value;
 * 2. `textSelect` unwraps each to its scalar text (or its verbatim JSON text);
 * 3. `castSelect` casts each to the type the serving table already has.
 *
 * Step 3 is where "byte-identical to the Parquet path" is won: the target type is
 * read off the live table, which `db/build.ts` typed by unifying the six Parquet
 * schemas, so ingest never re-derives the unification -- it inherits it. What
 * remains, the rename to normalized names and the vendor rewrite, is literally
 * `db/build.ts`'s own `projection()`, called on this relation.
 */

import type { Modality } from '@mriqc/shared';
import { normalizeColumnName } from '@mriqc/shared';
import { quoteIdent, type ColumnPlan, type SourceColumn } from '../db/build.js';
import type { DbConnection } from '../db/instance.js';
import { MANUFACTURER_COLUMN, MANUFACTURER_RAW_COLUMN } from '../db/vendors.js';

/* -------------------------------------------------------------- collections */

/** The four MRIQC Web-API collections a dump or a Mongo pull carries. */
export const INGEST_COLLECTIONS = ['T1w', 'T2w', 'bold', 'rating'] as const;

/** One of {@link INGEST_COLLECTIONS}. */
export type IngestCollection = (typeof INGEST_COLLECTIONS)[number];

/** True when `value` names a collection ingest knows how to stage. */
export function isIngestCollection(value: string): value is IngestCollection {
  return (INGEST_COLLECTIONS as readonly string[]).includes(value);
}

/** The serving table each collection's records land in. */
export const COLLECTION_TABLE: Readonly<Record<IngestCollection, string>> = {
  bold: 'raw_bold',
  T1w: 'raw_t1w',
  T2w: 'raw_t2w',
  rating: 'ratings',
};

/**
 * The modality whose canonical tables a collection's rows invalidate. Null for
 * `rating`: ratings are a join table, no policy groups them, and `ratings_by_md5`
 * is a view that follows along by itself.
 */
export const COLLECTION_MODALITY: Readonly<Record<IngestCollection, Modality | null>> = {
  bold: 'bold',
  T1w: 'T1w',
  T2w: 'T2w',
  rating: null,
};

/**
 * The `columns` table's `modality` value for one collection, which is the
 * modality for the three observation collections and the table name for the
 * ratings (`db/build.ts` records the auxiliary tables under their own names).
 */
export function columnsScopeOf(collection: IngestCollection): string {
  return COLLECTION_MODALITY[collection] ?? COLLECTION_TABLE[collection];
}

/* ------------------------------------------------------------- JSON paths */

/**
 * The DuckDB JSON path of one dotted source name.
 *
 * `bids_meta.EchoTime` becomes `$."bids_meta"."EchoTime"`. A key carrying a quote
 * or a backslash would need escaping that DuckDB's path grammar does not define,
 * and no MRIQC field has one, so such a name is refused rather than mangled.
 */
export function jsonPathOf(sourceName: string): string {
  const segments = sourceName.split('.');
  for (const segment of segments) {
    if (segment === '' || /["\\]/.test(segment)) {
      throw new Error(`cannot build a JSON path for source column ${JSON.stringify(sourceName)}`);
    }
  }
  return `$${segments.map((segment) => `."${segment}"`).join('')}`;
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The extended-JSON scalar wrappers, in the order `convert_T1w.sql` coalesces
 * them. `$oid` and `$date` come first because they are the only ones whose value
 * is not a number.
 */
export const EXTENDED_JSON_KEYS: readonly string[] = [
  '$oid',
  '$date',
  '$numberDouble',
  '$numberInt',
  '$numberLong',
  '$numberDecimal',
];

/**
 * The scalar text of one extracted JSON value.
 *
 * An extended-JSON wrapper object yields the wrapped string -- which is how
 * `"NaN"`, `"Infinity"` and `"-Infinity"` reach the DOUBLE cast intact. Any other
 * object, and every array, yields its JSON text verbatim, which is what KEY.md
 * says a non-scalar value is stored as. A JSON `null` literal and an absent key
 * both yield SQL NULL, which is the "field absent" state.
 */
export function scalarTextSql(valueExpr: string): string {
  const unwrapped = EXTENDED_JSON_KEYS.map(
    (key) => `json_extract_string(${valueExpr}, ${literal(`$."${key}"`)})`,
  ).join(', ');
  return (
    `CASE WHEN ${valueExpr} IS NULL OR json_type(${valueExpr}) = 'NULL' THEN NULL` +
    ` WHEN json_type(${valueExpr}) = 'OBJECT'` +
    ` THEN COALESCE(${unwrapped}, CAST(${valueExpr} AS VARCHAR))` +
    ` ELSE json_extract_string(${valueExpr}, '$') END`
  );
}

const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
]);

/**
 * Cast one column's scalar text to the type the serving table carries.
 *
 * Every cast is a `TRY_CAST`, as the Parquet load's narrowing casts are: a value
 * that cannot be represented becomes NULL instead of failing a whole nightly
 * ingest over one malformed record.
 *
 * The integer branch exists because DuckDB's two routes to an integer disagree:
 * `'1000.5'::BIGINT` rounds to 1001, while `1000.5::DOUBLE::BIGINT` truncates to
 * 1000. The Parquet path goes through DOUBLE, so non-integral text must too, or
 * an ingested row would differ from a loaded one by one. Integral text takes the
 * direct route, which keeps full 64-bit precision instead of passing through a
 * double's 53 bits.
 */
export function castToTypeSql(textExpr: string, duckType: string): string {
  const type = duckType.toUpperCase();
  if (type === 'VARCHAR') return textExpr;
  if (INTEGER_TYPES.has(type)) {
    return (
      `CASE WHEN regexp_full_match(${textExpr}, '-?[0-9]+')` +
      ` THEN TRY_CAST(${textExpr} AS ${type})` +
      ` ELSE TRY_CAST(TRY_CAST(${textExpr} AS DOUBLE) AS ${type}) END`
    );
  }
  return `TRY_CAST(${textExpr} AS ${duckType})`;
}

/* ------------------------------------------------------------- the staging */

/** The three projections that turn one JSON column into the serving columns. */
export interface StagingPlan {
  /** `SELECT` list over the one-JSON-column relation: each dotted path as JSON. */
  readonly jsonSelect: string;
  /** `SELECT` list over that: each column unwrapped to its scalar text. */
  readonly textSelect: string;
  /** `SELECT` list over that: each column cast to the serving table's type. */
  readonly castSelect: string;
  /**
   * The columns the third relation carries: the dotted source names at the
   * serving types, which is exactly the shape `db/build.ts`'s `projection()`
   * expects a Parquet file to have.
   */
  readonly columns: readonly SourceColumn[];
  /** The dotted source name of the vendor column, when the table has one. */
  readonly manufacturerSource: string | null;
}

/**
 * Plan the staging of one collection, given the serving table's own columns.
 *
 * `manufacturer_raw` is left out of the source list: `db/build.ts` creates it in
 * its projection from the same source column as `manufacturer`, and staging it
 * twice would make that projection see a duplicate.
 */
export function planStaging(targets: readonly ColumnPlan[]): StagingPlan {
  const json: string[] = [];
  const text: string[] = [];
  const cast: string[] = [];
  const columns: SourceColumn[] = [];
  const seen = new Set<string>();
  let manufacturerSource: string | null = null;

  for (const target of targets) {
    if (target.normalized === MANUFACTURER_RAW_COLUMN) continue;
    if (seen.has(target.sourceName)) {
      throw new Error(
        `two serving columns claim the source name ${JSON.stringify(target.sourceName)}`,
      );
    }
    seen.add(target.sourceName);
    if (target.normalized === MANUFACTURER_COLUMN) manufacturerSource = target.sourceName;
    const quoted = quoteIdent(target.sourceName);
    json.push(`json_extract("json", ${literal(jsonPathOf(target.sourceName))}) AS ${quoted}`);
    text.push(`${scalarTextSql(quoted)} AS ${quoted}`);
    cast.push(`${castToTypeSql(quoted, target.duckType)} AS ${quoted}`);
    columns.push({ name: target.sourceName, type: target.duckType });
  }

  if (columns.length === 0) throw new Error('nothing to stage: the target table has no columns');
  return {
    jsonSelect: json.join(',\n  '),
    textSelect: text.join(',\n  '),
    castSelect: cast.join(',\n  '),
    columns,
    manufacturerSource,
  };
}

/* ---------------------------------------------------- reading the live schema */

/** One serving table's columns as `DESCRIBE` reports them, in table order. */
export async function describeTable(
  connection: DbConnection,
  table: string,
): Promise<readonly SourceColumn[]> {
  const rows = await connection.all(`DESCRIBE ${quoteIdent(table)}`);
  return rows.map((row) => ({
    name: String(row['column_name']),
    type: String(row['column_type']),
  }));
}

/**
 * The staging targets of one collection: every column the serving table has,
 * paired with the source name `db/build.ts` recorded for it and the type the
 * table carries.
 *
 * The source names come from the `columns` table rather than from inverting
 * {@link normalizeColumnName}, which is not injective -- `bids_meta.EchoTime` and
 * a hypothetical top-level `echo_time` would normalize alike, and `id` could be
 * `_id` or `id`. A column the `columns` table never recorded is an error: ingest
 * would otherwise have to guess which JSON field feeds it.
 */
export async function targetColumnsOf(
  connection: DbConnection,
  collection: IngestCollection,
): Promise<ColumnPlan[]> {
  const table = COLLECTION_TABLE[collection];
  const described = await describeTable(connection, table);
  const rows = await connection.all(
    `SELECT "column" AS c, source_name AS s FROM columns WHERE modality = ?`,
    [columnsScopeOf(collection)],
  );
  const sources = new Map<string, string>();
  for (const row of rows) sources.set(String(row['c']), String(row['s']));

  return described.map((column) => {
    const sourceName = sources.get(column.name);
    if (sourceName === undefined) {
      throw new Error(
        `${table}.${column.name} has no row in the "columns" table, so ingest cannot` +
          ' tell which JSON field feeds it; rebuild the database with build:db',
      );
    }
    // A sanity check, not a lookup: the recorded source name must still normalize
    // to the column it is recorded against, or the two sides have drifted.
    // `manufacturer_raw` is the one exception -- the build invented it and
    // recorded it against `manufacturer`'s source name on purpose -- and it is
    // dropped from the staging anyway, since the projection recreates it.
    if (column.name !== MANUFACTURER_RAW_COLUMN && normalizeColumnName(sourceName) !== column.name) {
      throw new Error(
        `"columns" says ${table}.${column.name} came from ${sourceName}, which normalizes to` +
          ` ${normalizeColumnName(sourceName)}`,
      );
    }
    return { normalized: column.name, sourceName, duckType: column.type };
  });
}
