/**
 * Synthetic MongoDB extended-JSON dumps, and the manifest beside them.
 *
 * The interesting fixture here is {@link recordsFromTable}: it reads rows back out
 * of a built serving table and re-expresses them as the extended JSON a dump
 * carries, re-nesting each normalized column under the dotted source path the
 * `columns` table recorded for it. Ingesting that dump into a table emptied of
 * those rows must reproduce them exactly, which is how "a record ingested from a
 * dump is byte-identical to one loaded from Parquet" is asserted rather than
 * assumed: one set of values, two code paths, compared column by column.
 *
 * It works because a JSON number is written with the shortest text that
 * round-trips to the same IEEE double, so the only values needing special
 * treatment are the ones JSON has no literal for -- NaN and ±Infinity, which are
 * exactly what MongoDB's extended JSON wraps as `{"$numberDouble": "NaN"}`, and
 * which KEY.md says the Parquet conversion preserved rather than nulled.
 *
 * Not part of the shipped package: `tsconfig.json` excludes this directory.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbConnection, Row } from '../db/instance.js';
import { MANIFEST_FILE } from '../ingest/sources.js';
import { COLLECTION_TABLE, type IngestCollection } from '../ingest/flatten.js';
import { MANUFACTURER_COLUMN } from '../db/vendors.js';

/** One extended-JSON value, as a dump spells it. */
export type ExtendedJsonValue =
  | string
  | number
  | boolean
  | null
  | { $date: string }
  | { $numberLong: string }
  | { $numberDouble: string }
  | { [key: string]: ExtendedJsonValue };

/**
 * One column value as extended JSON.
 *
 * `bigint` becomes `{"$numberLong": …}` and a non-finite double
 * `{"$numberDouble": …}`, which are the two wrappers the real dumps use and the
 * two JSON has no literal for. Everything else is a plain JSON value.
 */
export function toExtendedJson(value: unknown): ExtendedJsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === 'bigint') return { $numberLong: value.toString() };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $numberDouble: 'NaN' };
    if (value === Number.POSITIVE_INFINITY) return { $numberDouble: 'Infinity' };
    if (value === Number.NEGATIVE_INFINITY) return { $numberDouble: '-Infinity' };
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

/** Set `object[a][b][c]` from a dotted source path, creating the objects on the way. */
export function setDotted(
  object: Record<string, ExtendedJsonValue>,
  dotted: string,
  value: ExtendedJsonValue,
): void {
  const segments = dotted.split('.');
  let cursor = object;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      const created: Record<string, ExtendedJsonValue> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = existing as Record<string, ExtendedJsonValue>;
    }
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/** The `columns` table's normalized-to-source mapping for one scope. */
export async function sourceNamesOf(
  connection: DbConnection,
  scope: string,
): Promise<Map<string, string>> {
  const rows = await connection.all(
    `SELECT "column" AS c, source_name AS s FROM columns WHERE modality = ?`,
    [scope],
  );
  return new Map(rows.map((row) => [String(row['c']), String(row['s'])]));
}

/**
 * Turn serving rows back into dump records.
 *
 * `manufacturer` is skipped and `manufacturer_raw` emitted in its place: the two
 * share a source name, and the uploaded string is the one a dump carries. That
 * the canonical spelling comes back is then a property of the ingest, not of the
 * fixture.
 */
export function recordsFromRows(
  rows: readonly Row[],
  sources: ReadonlyMap<string, string>,
  overrides: (row: Row, record: Record<string, ExtendedJsonValue>) => void = () => undefined,
): Record<string, ExtendedJsonValue>[] {
  return rows.map((row) => {
    const record: Record<string, ExtendedJsonValue> = {};
    for (const [column, value] of Object.entries(row)) {
      if (column === MANUFACTURER_COLUMN) continue;
      const dotted = sources.get(column);
      if (dotted === undefined) continue;
      setDotted(record, dotted, toExtendedJson(value));
    }
    overrides(row, record);
    return record;
  });
}

/** Read rows out of one collection's serving table and re-express them as a dump. */
export async function recordsFromTable(
  connection: DbConnection,
  collection: IngestCollection,
  where = 'TRUE',
  overrides?: (row: Row, record: Record<string, ExtendedJsonValue>) => void,
): Promise<Record<string, ExtendedJsonValue>[]> {
  const table = COLLECTION_TABLE[collection];
  const scope = collection === 'rating' ? table : collection;
  const rows = await connection.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`);
  return recordsFromRows(rows, await sourceNamesOf(connection, scope), overrides);
}

/** One dump file written into a directory, as the manifest describes it. */
export interface WrittenDump {
  readonly file: string;
  readonly collection: IngestCollection;
  readonly records: number;
  readonly maxUpdated: string | null;
  readonly sha256: string;
  readonly path: string;
}

/** Write one `--jsonArray` dump file and return the manifest entry for it. */
export function writeDumpFile(
  dir: string,
  collection: IngestCollection,
  records: readonly Record<string, ExtendedJsonValue>[],
  stamp = '20261008T030405',
): WrittenDump {
  mkdirSync(dir, { recursive: true });
  const file = `mriqc_api.${collection}.${stamp}.json`;
  const path = join(dir, file);
  const text = `${JSON.stringify(records, null, 2)}\n`;
  writeFileSync(path, text);
  let maxUpdated: string | null = null;
  for (const record of records) {
    const updated = record['_updated'];
    const iso =
      typeof updated === 'object' && updated !== null && '$date' in updated
        ? String((updated as { $date: string }).$date)
        : null;
    if (iso !== null && (maxUpdated === null || Date.parse(iso) > Date.parse(maxUpdated))) {
      maxUpdated = iso;
    }
  }
  return {
    file,
    collection,
    records: records.length,
    maxUpdated,
    sha256: createHash('sha256').update(text).digest('hex'),
    path,
  };
}

/** Write a `manifest.json` describing the dumps already in `dir`. */
export function writeDumpManifest(dir: string, dumps: readonly WrittenDump[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, MANIFEST_FILE),
    `${JSON.stringify(
      {
        version: 1,
        files: dumps.map((dump) => ({
          file: dump.file,
          collection: dump.collection,
          records: dump.records,
          maxUpdated: dump.maxUpdated,
          since: null,
          sha256: dump.sha256,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

/** Write one dump plus its manifest into a fresh directory, the common case. */
export function writeDumpDir(
  dir: string,
  dumps: readonly {
    collection: IngestCollection;
    records: readonly Record<string, ExtendedJsonValue>[];
    stamp?: string;
  }[],
): WrittenDump[] {
  const written = dumps.map((dump) =>
    writeDumpFile(dir, dump.collection, dump.records, dump.stamp),
  );
  writeDumpManifest(dir, written);
  return written;
}
