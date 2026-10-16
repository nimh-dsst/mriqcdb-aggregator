/**
 * The mean rating, materialized onto every observation row.
 *
 * Ratings are their own collection, keyed by the rated image's md5sum, and
 * `ratings_by_md5` averages them per md5. This copies that average onto each
 * raw row whose `provenance_md5sum` matches, so it is an ordinary column -- a
 * metric to plot, a range to filter, a field to export -- and no query has to
 * join the ratings. The canonical tables pick it up through the policies'
 * `r.*`, and every canonical key carries `provenance_md5sum`, so a canonical row
 * holds the rating of exactly the md5 it stands for.
 *
 * It is derived, not uploaded: ingest never stages it (`ingest/flatten.ts`,
 * `ingest/ingest.ts`), the frozen column policy never records it
 * (`columns-policy.ts`), and {@link refreshMeanRating} rewrites it after every
 * change to either side.
 */

import type { Modality } from '@mriqc/shared';
import { quoteIdent } from '../sql/filters.js';
import type { DbConnection } from './instance.js';
import { tableFor } from './views.js';

export const MEAN_RATING_COLUMN = 'mean_rating';

/** Columns the database computes rather than reads from an upload. */
export const DERIVED_COLUMNS: ReadonlySet<string> = new Set([MEAN_RATING_COLUMN]);

/** Every raw table, by modality. */
export const RAW_RATED_TABLES: ReadonlyArray<readonly [Modality, string]> = (
  ['bold', 'T1w', 'T2w'] as const
).map((modality) => [modality, tableFor(modality, 'raw')] as const);

/** True when `table` exists in the main schema. */
export async function hasTable(connection: DbConnection, table: string): Promise<boolean> {
  const rows = await connection.all(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?`,
    [table],
  );
  return rows.length > 0;
}

/** Add the `mean_rating` column to `table` if it has none. Returns true when it was added. */
export async function ensureMeanRatingColumn(connection: DbConnection, table: string): Promise<boolean> {
  const rows = await connection.all(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'main' AND table_name = ? AND column_name = ?`,
    [table, MEAN_RATING_COLUMN],
  );
  if (rows.length > 0) return false;

  await connection.exec(
    `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(MEAN_RATING_COLUMN)} DOUBLE`,
  );
  return true;
}

/** Refill `table`'s `mean_rating` from `ratings_by_md5`; a row with no rating gets NULL. */
export async function refreshMeanRating(connection: DbConnection, table: string): Promise<void> {
  const target = quoteIdent(table);
  await connection.exec(
    `UPDATE ${target} SET ${quoteIdent(MEAN_RATING_COLUMN)} = (
       SELECT r.mean_rating FROM ratings_by_md5 r WHERE r.md5sum = ${target}.provenance_md5sum
     )`,
  );
}

/** Record the derived column in the `columns` table for `modality`, once. */
export async function recordMeanRating(connection: DbConnection, modality: Modality): Promise<void> {
  await connection.exec(
    `INSERT INTO columns (modality, "column", source_name, duck_type)
     SELECT ?, ?, ?, 'DOUBLE'
     WHERE NOT EXISTS (SELECT 1 FROM columns WHERE modality = ? AND "column" = ?)`,
    [modality, MEAN_RATING_COLUMN, MEAN_RATING_COLUMN, modality, MEAN_RATING_COLUMN],
  );
}
