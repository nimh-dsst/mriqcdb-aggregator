/**
 * The ingest job.
 *
 * See `docs/backend-graph.md`, "Ingest from dumps (decided 2026-10-08)". One
 * function, two sources (`ingest/sources.ts`), and one writer transaction:
 *
 * 1. ask the source for the units that are new -- a dump file whose sha256 is not
 *    in `ingest_log`, or a Mongo page past the `_updated` watermark that table
 *    records;
 * 2. stage each unit with `read_json`, flatten it with the Parquet conversion's
 *    own rules and run `db/build.ts`'s projection over it, so an ingested record
 *    is byte-identical to the same record loaded from Parquet
 *    (`ingest/flatten.ts`);
 * 3. upsert into the raw table by `id`: a re-sent record with a strictly newer
 *    `updated_at` replaces the old row, so raw stays one row per observation;
 * 4. recompute the canonical tables of every modality that received rows, under
 *    the frozen scales, through the existing policy views;
 * 5. commit -- all of the above is one transaction, so no reader ever sees raw and
 *    canonical tables that disagree;
 * 6. then, outside the transaction: bump `data_version` (which now also hashes
 *    `ingest_log`), invalidate the catalog, emit the version event, and write
 *    `snapshots/mriqc-<version>.duckdb`, keeping the last three.
 *
 * `--dry-run` does 1 through 3 and rolls back, so the numbers it prints are
 * measured rather than guessed, and skips step 4, which on the full corpus costs
 * minutes a dry run has no use for.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Modality } from '@mriqc/shared';
import {
  DUCKDB_MEMORY_LIMIT,
  INGEST_MEMORY_LIMIT,
  INGEST_SOURCE,
  MRIQC_DUMP_DIR,
  MRIQC_MONGO_URI,
  SNAPSHOT_DIR,
  SNAPSHOT_KEEP,
} from '../config.js';
import { materializePolicy, projection, quoteIdent, type ColumnPlan } from '../db/build.js';
import { CANONICAL_POLICIES, policyCanonTable, type CanonicalPolicy } from '../db/canonical.js';
import { getDb, type Db, type DbConnection } from '../db/instance.js';
import { readVendorMap, vendorCaseSql } from '../db/vendors.js';
import {
  COLLECTION_MODALITY,
  COLLECTION_TABLE,
  describeTable,
  planStaging,
  scalarTextSql,
  targetColumnsOf,
  type IngestCollection,
} from './flatten.js';
import {
  DumpDirSource,
  MongoSource,
  type IngestSource,
  type IngestState,
  type IngestUnit,
} from './sources.js';
import { publishDataVersion } from './version.js';

/* ------------------------------------------------------------------ schema */

/**
 * The relations ingest writes into, created on first use so a database built
 * before this code shipped can be ingested into without a rebuild.
 *
 * `meta.base_data_version` is what makes the live version derivable rather than
 * chained: `data_version` is a hash of the build's own version and the
 * `ingest_log`, so it changes exactly when the log does, and two servers that
 * ingested the same files agree on it.
 */
export async function ensureIngestSchema(connection: DbConnection): Promise<void> {
  await connection.exec(
    `CREATE TABLE IF NOT EXISTS ingest_log (
       ingested_at TIMESTAMP,
       source VARCHAR,
       file VARCHAR,
       sha256 VARCHAR,
       collection VARCHAR,
       records BIGINT,
       rows_appended BIGINT,
       rows_replaced BIGINT,
       rows_skipped BIGINT,
       updated_min TIMESTAMP,
       updated_max TIMESTAMP,
       canonical_before BIGINT,
       canonical_after BIGINT,
       duration_ms BIGINT,
       data_version VARCHAR
     )`,
  );
  await connection.exec(`ALTER TABLE meta ADD COLUMN IF NOT EXISTS base_data_version VARCHAR`);
  await connection.exec(
    `UPDATE meta SET base_data_version = data_version WHERE base_data_version IS NULL`,
  );
}

/** What `ingest_log` and `meta` already say, read before anything is staged. */
export interface IngestStartState extends IngestState {
  /** The version the build wrote, which every live version is derived from. */
  readonly baseDataVersion: string;
  /** The version `meta` currently serves. */
  readonly dataVersion: string;
}

/** Read the skip set, the per-collection watermark and the two versions. */
export async function readIngestState(connection: DbConnection): Promise<IngestStartState> {
  const hashes = await connection.all(
    `SELECT DISTINCT sha256 AS h FROM ingest_log WHERE sha256 IS NOT NULL`,
  );
  const marks = await connection.all(
    `SELECT collection AS c, max(updated_max) AS hi FROM ingest_log
     WHERE updated_max IS NOT NULL GROUP BY collection`,
  );
  const meta = await connection.all(
    `SELECT data_version AS v, base_data_version AS b FROM meta LIMIT 1`,
  );
  const watermarks = new Map<IngestCollection, Date>();
  for (const row of marks) {
    const value = row['hi'];
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(date.getTime())) watermarks.set(String(row['c']) as IngestCollection, date);
  }
  const dataVersion = String(meta[0]?.['v'] ?? '');
  const base = meta[0]?.['b'];
  return {
    knownHashes: new Set(hashes.map((row) => String(row['h']))),
    watermarks,
    dataVersion,
    baseDataVersion: base === null || base === undefined ? dataVersion : String(base),
  };
}

/**
 * The live `data_version`: the build's own version, plus every `ingest_log` row
 * that actually changed a table.
 *
 * Rows that changed nothing are left out on purpose. A nightly pull that re-reads
 * the boundary record, or a new dump file holding only records the database
 * already has, must not move the ETag and invalidate every cached answer for no
 * reason -- `data_version` is a claim about what queries would return.
 */
export function ingestDataVersion(base: string, lines: readonly string[]): string {
  if (lines.length === 0) return base;
  return createHash('sha256')
    .update([`base ${base}`, ...[...lines].sort()].join('\n'))
    .digest('hex');
}

/** The digest lines of every `ingest_log` row that appended or replaced a row. */
async function ingestLogLines(connection: DbConnection): Promise<string[]> {
  const rows = await connection.all(
    `SELECT collection AS c,
            coalesce(sha256, '') AS h,
            coalesce(CAST(updated_max AS VARCHAR), '') AS hi,
            coalesce(records, 0) AS n,
            coalesce(rows_appended, 0) AS a,
            coalesce(rows_replaced, 0) AS r
     FROM ingest_log
     WHERE coalesce(rows_appended, 0) + coalesce(rows_replaced, 0) > 0`,
  );
  return rows.map(
    (row) =>
      `unit ${String(row['c'])} ${String(row['h'])} ${String(row['hi'])}` +
      ` ${String(row['n'])} ${String(row['a'])} ${String(row['r'])}`,
  );
}

/* ------------------------------------------------------------- the staging */

const STAGE_JSON = 'ingest_stage_json';
const STAGE_TEXT = 'ingest_stage_text';
const STAGE_SRC = 'ingest_stage_src';
const STAGE = 'ingest_stage';
const STAGE_DECIDE = 'ingest_stage_decide';
const STAGE_APPLY = 'ingest_stage_apply';

/** Dependency order reversed, so a view is dropped before what it reads. */
const STAGE_RELATIONS = [STAGE_APPLY, STAGE_DECIDE, STAGE, STAGE_SRC, STAGE_TEXT, STAGE_JSON];

/** What staging and upserting one unit measured. */
export interface UnitCounts {
  readonly staged: number;
  readonly appended: number;
  readonly replaced: number;
  readonly skipped: number;
  readonly updatedMin: string | null;
  readonly updatedMax: string | null;
}

/** Forward slashes only: DuckDB takes a POSIX-style path on Windows too. */
function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Drop every staging relation, as a table and as a view.
 *
 * Both spellings are tried and both failures ignored: `DROP VIEW` refuses a name
 * that is a table even with `IF EXISTS`, and which of the two a name currently is
 * depends on where a previous run stopped.
 */
export async function dropStaging(connection: DbConnection): Promise<void> {
  for (const relation of STAGE_RELATIONS) {
    for (const kind of ['TABLE', 'VIEW']) {
      try {
        await connection.exec(`DROP ${kind} IF EXISTS ${quoteIdent(relation)}`);
      } catch {
        // The name is the other kind, which the other statement handles.
      }
    }
  }
}

/**
 * Stage one unit's JSON file into {@link STAGE}, at the serving table's own
 * columns, types and names, one row per `id` with the newest `updated_at`.
 *
 * The dedupe inside the unit is not paranoia: a `mongoexport` window that
 * overlaps a previous one, or a Mongo page re-read from its watermark, can carry
 * the same `_id` twice, and inserting both would break raw's one-row-per-
 * observation invariant before the canonical policies ever saw it.
 */
export async function stageUnit(
  connection: DbConnection,
  collection: IngestCollection,
  jsonPath: string,
  targets: readonly ColumnPlan[],
  limit: number | null = null,
): Promise<number> {
  const table = COLLECTION_TABLE[collection];
  if (!targets.some((target) => target.normalized === 'id')) {
    throw new Error(`${table} has no "id" column, so ingest cannot upsert into it`);
  }
  const plan = planStaging(targets);
  await dropStaging(connection);
  await connection.exec(
    `CREATE VIEW ${quoteIdent(STAGE_JSON)} AS SELECT\n  ${plan.jsonSelect}\n` +
      `FROM read_json_objects(${literal(posix(jsonPath))}, format = 'array')` +
      (limit === null ? '' : ` LIMIT ${limit}`),
  );
  await connection.exec(
    `CREATE VIEW ${quoteIdent(STAGE_TEXT)} AS SELECT\n  ${plan.textSelect}\n` +
      `FROM ${quoteIdent(STAGE_JSON)}`,
  );
  await connection.exec(
    `CREATE VIEW ${quoteIdent(STAGE_SRC)} AS SELECT\n  ${plan.castSelect}\n` +
      `FROM ${quoteIdent(STAGE_TEXT)}`,
  );

  // The vendor `CASE` is generated from the values this unit actually carries,
  // exactly as the build generates it from a Parquet file's distinct values, so
  // the normalization rule stays in `db/vendors.ts` and DuckDB only ever compares
  // exact literals. The scan is over the *text* relation, which holds the same
  // uploaded string the build reads out of Parquet.
  let vendorCase: string | null = null;
  if (plan.manufacturerSource !== null) {
    const rows = await connection.all(
      `SELECT DISTINCT ${quoteIdent(plan.manufacturerSource)} AS v FROM ${quoteIdent(STAGE_TEXT)}`,
    );
    const values = rows.map((row) =>
      row['v'] === null || row['v'] === undefined ? null : String(row['v']),
    );
    vendorCase = vendorCaseSql(quoteIdent(plan.manufacturerSource), values, readVendorMap());
  }

  // The same `projection()` the Parquet load uses. The staged relation is already
  // at the serving types, so every cast in it is the identity and what is left is
  // the rename to normalized names plus the vendor rewrite.
  const planMap = new Map<string, ColumnPlan>(targets.map((target) => [target.normalized, target]));
  const { sql } = projection(plan.columns, planMap, vendorCase);
  const hasUpdatedAt = targets.some((target) => target.normalized === 'updated_at');

  await connection.exec(
    `CREATE TABLE ${quoteIdent(STAGE)} AS
     SELECT * FROM (SELECT\n  ${sql}\nFROM ${quoteIdent(STAGE_SRC)}) q
     WHERE q.id IS NOT NULL
     QUALIFY row_number() OVER (
       PARTITION BY q.id
       ORDER BY ${hasUpdatedAt ? 'q.updated_at DESC NULLS LAST' : 'q.id'}
     ) = 1`,
  );
  const read = await connection.all(`SELECT count(*) AS n FROM ${quoteIdent(STAGE_JSON)}`);
  return Number(read[0]?.['n'] ?? 0);
}

/**
 * Decide each staged row against the serving table and apply the decision.
 *
 * A row whose `id` is new is appended. A row whose `id` is present is replaced
 * only when its `updated_at` is strictly newer, which is what makes a re-sent
 * record idempotent: ingesting the same dump twice appends nothing and replaces
 * nothing. A table without an `updated_at` column has no such test, and every
 * staged row replaces what is there.
 */
export async function applyStaged(
  connection: DbConnection,
  collection: IngestCollection,
): Promise<UnitCounts> {
  const table = COLLECTION_TABLE[collection];
  const target = quoteIdent(table);
  const columns = await describeTable(connection, table);
  const hasUpdatedAt = columns.some((column) => column.name === 'updated_at');
  const stagedUpdated = hasUpdatedAt ? 's.updated_at' : 'CAST(NULL AS TIMESTAMP)';
  const servedUpdated = hasUpdatedAt
    ? `(SELECT max(r.updated_at) FROM ${target} r WHERE r.id = s.id)`
    : 'CAST(NULL AS TIMESTAMP)';

  await connection.exec(
    `CREATE TABLE ${quoteIdent(STAGE_DECIDE)} AS
     SELECT s.id AS id,
            ${stagedUpdated} AS s_updated,
            ${servedUpdated} AS r_updated,
            EXISTS (SELECT 1 FROM ${target} r WHERE r.id = s.id) AS present
     FROM ${quoteIdent(STAGE)} s`,
  );

  const newer = hasUpdatedAt
    ? 's_updated IS NOT NULL AND (r_updated IS NULL OR s_updated > r_updated)'
    : 'TRUE';
  const measured = await connection.all(
    `SELECT count(*) AS staged,
            count(*) FILTER (WHERE NOT present) AS appended,
            count(*) FILTER (WHERE present AND (${newer})) AS replaced,
            CAST(min(s_updated) AS VARCHAR) AS lo,
            CAST(max(s_updated) AS VARCHAR) AS hi
     FROM ${quoteIdent(STAGE_DECIDE)}`,
  );
  const row = measured[0] ?? {};
  const staged = Number(row['staged'] ?? 0);
  const appended = Number(row['appended'] ?? 0);
  const replaced = Number(row['replaced'] ?? 0);

  await connection.exec(
    `CREATE TABLE ${quoteIdent(STAGE_APPLY)} AS
     SELECT id FROM ${quoteIdent(STAGE_DECIDE)} WHERE NOT present OR (${newer})`,
  );
  await connection.exec(
    `DELETE FROM ${target} WHERE id IN (SELECT id FROM ${quoteIdent(STAGE_APPLY)})`,
  );
  const list = columns.map((column) => quoteIdent(column.name)).join(', ');
  await connection.exec(
    `INSERT INTO ${target} (${list})
     SELECT ${list} FROM ${quoteIdent(STAGE)}
     WHERE id IN (SELECT id FROM ${quoteIdent(STAGE_APPLY)})`,
  );

  return {
    staged,
    appended,
    replaced,
    skipped: staged - appended - replaced,
    updatedMin: row['lo'] === null || row['lo'] === undefined ? null : String(row['lo']),
    updatedMax: row['hi'] === null || row['hi'] === undefined ? null : String(row['hi']),
  };
}

/* --------------------------------------------------------------- snapshots */

/** The snapshot file one `data_version` is copied to. */
export function snapshotPathOf(directory: string, dataVersion: string): string {
  return posix(join(directory, `mriqc-${dataVersion}.duckdb`));
}

/**
 * Copy the committed database to `snapshots/mriqc-<version>.duckdb` and keep the
 * newest `keep`.
 *
 * `COPY FROM DATABASE` needs an `ATTACH`, which DuckDB refuses inside a
 * transaction, so this runs after the commit -- which is also the only point at
 * which a snapshot would be worth having. The catalog name is asked for rather
 * than derived from the file name, because DuckDB sanitizes it (`main.duckdb`
 * attaches as `main_db`).
 */
export async function writeSnapshot(
  connection: DbConnection,
  directory: string,
  dataVersion: string,
  keep: number,
): Promise<{ path: string; pruned: string[] }> {
  mkdirSync(directory, { recursive: true });
  const path = snapshotPathOf(directory, dataVersion);
  const rows = await connection.all(`SELECT current_database() AS db`);
  const catalog = String(rows[0]?.['db'] ?? 'memory');
  rmSync(path, { force: true });
  rmSync(`${path}.wal`, { force: true });
  await connection.exec(`ATTACH ${literal(path)} AS ingest_snapshot`);
  try {
    await connection.exec(`COPY FROM DATABASE ${quoteIdent(catalog)} TO ingest_snapshot`);
  } finally {
    await connection.exec(`DETACH ingest_snapshot`);
  }
  return { path, pruned: pruneSnapshots(directory, keep) };
}

/** Remove every snapshot past the newest `keep`, newest by modification time. */
export function pruneSnapshots(directory: string, keep: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const snapshots = entries
    .filter((name) => /^mriqc-[0-9a-f]+\.duckdb$/.test(name))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const pruned: string[] = [];
  for (const snapshot of snapshots.slice(keep)) {
    rmSync(join(directory, snapshot.name), { force: true });
    rmSync(join(directory, `${snapshot.name}.wal`), { force: true });
    pruned.push(snapshot.name);
  }
  return pruned;
}

/* ------------------------------------------------------------------ result */

/** One `ingest_log` row, as the result reports it. */
export interface IngestedUnit {
  readonly collection: IngestCollection;
  readonly file: string | null;
  readonly sha256: string | null;
  readonly records: number;
  readonly rowsAppended: number;
  readonly rowsReplaced: number;
  readonly rowsSkipped: number;
  readonly updatedMin: string | null;
  readonly updatedMax: string | null;
  readonly durationMs: number;
}

/** What one ingest run did. */
export interface IngestResult {
  readonly source: 'dumps' | 'mongo';
  readonly dryRun: boolean;
  readonly units: readonly IngestedUnit[];
  /** Modalities whose canonical tables were recomputed. */
  readonly recomputed: readonly Modality[];
  /** Canonical table row counts per policy id, before and after the recompute. */
  readonly canonicalBefore: Readonly<Record<string, number>>;
  readonly canonicalAfter: Readonly<Record<string, number>>;
  readonly previousDataVersion: string;
  readonly dataVersion: string;
  readonly snapshot: string | null;
  readonly prunedSnapshots: readonly string[];
  readonly elapsedMs: number;
}

/** Options for {@link ingest}. Every one has a configured default. */
export interface IngestOptions {
  /** Bootstrap an empty schema: compute all policies, including empty collections. */
  initializeCanonical?: boolean;
  /** Build-only cap across all files of each collection. Partial files are not hash-deduped. */
  sample?: number | null;
  /** Override the normal ingest headroom for an isolated database build. */
  memoryLimit?: string;
  /** The database to write. Defaults to the process-wide one. */
  db?: Db;
  /** The source. Defaults to what `INGEST_SOURCE` and the dump directory say. */
  source?: IngestSource;
  /** Dump directory, when the default dump source is used. */
  dumpsDir?: string;
  /** Recompute each dump file's sha256 rather than trusting the manifest. */
  verify?: boolean;
  /** Measure and print what would change, then roll back. */
  dryRun?: boolean;
  /** Where snapshots go; null writes none. */
  snapshotDir?: string | null;
  /** How many snapshots to keep. */
  snapshotKeep?: number;
  log?: (message: string) => void;
}

/** The source the configuration asks for, when the caller named none. */
export function defaultSource(options: IngestOptions = {}): IngestSource {
  const log = options.log ?? ((): void => undefined);
  if (INGEST_SOURCE === 'mongo' && options.dumpsDir === undefined) {
    if (MRIQC_MONGO_URI === null) {
      throw new Error('INGEST_SOURCE=mongo but MRIQC_MONGO_URI is not set in the environment');
    }
    return new MongoSource({ uri: MRIQC_MONGO_URI, log });
  }
  return new DumpDirSource(options.dumpsDir ?? MRIQC_DUMP_DIR, {
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    log,
  });
}

/** Whether this database's canonical tables can be recomputed from the policy views. */
async function canonicalIsComputed(connection: DbConnection): Promise<boolean> {
  const rows = await connection.all(`SELECT policies AS p FROM meta LIMIT 1`);
  try {
    const parsed = JSON.parse(String(rows[0]?.['p'] ?? '{}')) as { canonicalSource?: string };
    return parsed.canonicalSource !== 'parquet';
  } catch {
    return false;
  }
}

async function canonicalCounts(
  connection: DbConnection,
  policies: readonly CanonicalPolicy[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const policy of policies) {
    const rows = await connection.all(
      `SELECT count(*) AS n FROM ${quoteIdent(policyCanonTable(policy))}`,
    );
    counts[policy.id] = Number(rows[0]?.['n'] ?? 0);
  }
  return counts;
}

/** The canonical row count of the policies belonging to one collection's modality. */
function canonicalTotal(
  counts: Readonly<Record<string, number>>,
  collection: IngestCollection,
): number | null {
  const modality = COLLECTION_MODALITY[collection];
  if (modality === null) return null;
  const present = CANONICAL_POLICIES.filter(
    (policy) => policy.modality === modality && counts[policy.id] !== undefined,
  );
  if (present.length === 0) return null;
  return present.reduce((sum, policy) => sum + (counts[policy.id] ?? 0), 0);
}

/**
 * Write a unit's in-memory records to a temporary JSON array file.
 *
 * The driver path could in principle insert row by row, but then it would be a
 * second, separately tested flattener. Spilling the page as the same
 * `--jsonArray` text `mongoexport` writes means the Mongo source and the dump
 * source share every line of staging, normalization and upsert code below this
 * point -- which is the property `ingest.test.ts` asserts.
 */
function spillToFile(unit: IngestUnit, temporaries: string[]): string {
  if (unit.records === undefined) {
    throw new Error(`ingest unit for ${unit.collection} carries neither a path nor records`);
  }
  const path = posix(
    join(tmpdir(), `mriqc-ingest-${process.pid}-${temporaries.length}-${unit.collection}.json`),
  );
  writeFileSync(path, JSON.stringify(unit.records));
  temporaries.push(path);
  return path;
}

/** What the transaction reported back to the caller. */
interface Outcome {
  readonly units: readonly IngestedUnit[];
  readonly recomputed: readonly Modality[];
  readonly canonicalBefore: Readonly<Record<string, number>>;
  readonly canonicalAfter: Readonly<Record<string, number>>;
  readonly previousDataVersion: string;
  readonly dataVersion: string;
  /** True when the transaction committed *and* moved `data_version`. */
  readonly changed: boolean;
}

/**
 * Run one ingest.
 *
 * The whole run holds the writer mutex, so a second ingest -- the nightly
 * schedule firing while the CLI is still going -- waits rather than interleaves.
 */
export async function ingest(options: IngestOptions = {}): Promise<IngestResult> {
  const started = Date.now();
  const db = options.db ?? getDb();
  const log = options.log ?? ((message: string) => console.log(message));
  const dryRun = options.dryRun === true;
  const source = options.source ?? defaultSource(options);
  const snapshotDir = options.snapshotDir === undefined ? SNAPSHOT_DIR : options.snapshotDir;
  const snapshotKeep = options.snapshotKeep ?? SNAPSHOT_KEEP;
  const temporaries: string[] = [];

  try {
    const outcome = await db.withWriter(async (connection): Promise<Outcome> => {
      // The writer mutex covers both changes. DuckDB's memory limit is global,
      // so concurrent reads share the extra headroom until the transaction ends.
      const previousMemory = await connection.all(`SELECT current_setting('memory_limit') AS value`);
      await connection.exec('SET memory_limit = ?', [options.memoryLimit ?? INGEST_MEMORY_LIMIT]);
      // Everything, the schema creation included, is inside the transaction, so a
      // dry run really does leave the file as it found it.
      try {
        await connection.exec('BEGIN TRANSACTION');
        await ensureIngestSchema(connection);
        const state = await readIngestState(connection);
        log(`ingest${dryRun ? ' (dry run)' : ''} from ${source.describe()}`);

        const units: IngestedUnit[] = [];
        const modalities = new Set<Modality>();
        const targetCache = new Map<IngestCollection, ColumnPlan[]>();
        const documentsRead = new Map<IngestCollection, number>();
        if (options.initializeCanonical) {
          await connection.exec(`CREATE TEMP TABLE build_scanner_records (
            collection VARCHAR, id VARCHAR, manufacturer VARCHAR, manufacturers_model_name VARCHAR,
            magnetic_field_strength VARCHAR, device_serial_number VARCHAR, software_versions VARCHAR,
            created_at TIMESTAMP)`);
        }
        let touched = false;

        for await (const unit of source.units(state)) {
          const remaining = options.sample == null ? null : options.sample - (documentsRead.get(unit.collection) ?? 0);
          if (remaining !== null && remaining <= 0) continue;
          const unitStarted = Date.now();
          const path = unit.path ?? spillToFile(unit, temporaries);
          let targets = targetCache.get(unit.collection);
          if (targets === undefined) {
            targets = await targetColumnsOf(connection, unit.collection);
            targetCache.set(unit.collection, targets);
          }
          const records = await stageUnit(connection, unit.collection, path, targets, remaining);
          documentsRead.set(unit.collection, (documentsRead.get(unit.collection) ?? 0) + records);
          const counts = await applyStaged(connection, unit.collection);
          if (options.initializeCanonical && unit.collection !== 'rating') {
            // Preserve the uploaded scanner tuple before casts/vendor normalization,
            // matching schema_catalog.py's scanner key (including 3 versus 3.0).
            const sourceValue = (source: string): string => targets.some((t) => t.sourceName === source)
              ? `json_extract_string(${quoteIdent(source)}, '$')` : 'NULL';
            const idSource = targets.find((t) => t.normalized === 'id')!.sourceName;
            const updatedSource = targets.find((t) => t.normalized === 'updated_at')?.sourceName;
            const createdSource = targets.find((t) => t.normalized === 'created_at')?.sourceName;
            const id = scalarTextSql(quoteIdent(idSource));
            const updated = updatedSource === undefined ? 'NULL' : `TRY_CAST(${scalarTextSql(quoteIdent(updatedSource))} AS TIMESTAMP)`;
            const created = createdSource === undefined ? 'NULL' : `TRY_CAST(${scalarTextSql(quoteIdent(createdSource))} AS TIMESTAMP)`;
            await connection.exec(`DELETE FROM build_scanner_records WHERE collection = ?
              AND id IN (SELECT id FROM ${quoteIdent(STAGE_APPLY)})`, [unit.collection]);
            await connection.exec(`INSERT INTO build_scanner_records
              SELECT ?, ${id}, ${['Manufacturer', 'ManufacturersModelName', 'MagneticFieldStrength', 'DeviceSerialNumber', 'SoftwareVersions'].map((name) => sourceValue(`bids_meta.${name}`)).join(', ')}, ${created}
              FROM ${quoteIdent(STAGE_JSON)} WHERE ${id} IN (SELECT id FROM ${quoteIdent(STAGE_APPLY)})
              QUALIFY row_number() OVER (PARTITION BY ${id} ORDER BY ${updated} DESC NULLS LAST) = 1`, [unit.collection]);
          }
          await dropStaging(connection);

          const modality = COLLECTION_MODALITY[unit.collection];
          const effective = counts.appended + counts.replaced > 0;
          if (effective) touched = true;
          if (effective && modality !== null) modalities.add(modality);
          units.push({
            collection: unit.collection,
            file: unit.file,
            sha256: remaining !== null && (unit.recordCount === undefined || records < unit.recordCount) ? null : unit.sha256,
            records,
            rowsAppended: counts.appended,
            rowsReplaced: counts.replaced,
            rowsSkipped: counts.skipped,
            updatedMin: counts.updatedMin,
            updatedMax: counts.updatedMax,
            durationMs: Date.now() - unitStarted,
          });
          log(
            `  ${unit.collection} ${unit.file ?? 'page'}: ${records} docs read / ${counts.appended + counts.replaced} rows written; ${counts.appended} appended,` +
              ` ${counts.replaced} replaced, ${counts.skipped} unchanged` +
              ` (${((Date.now() - unitStarted) / 1000).toFixed(1)} s)`,
          );
        }

        if (options.initializeCanonical) {
          const tuple = ['manufacturer', 'manufacturers_model_name', 'magnetic_field_strength', 'device_serial_number', 'software_versions'];
          await connection.exec(`INSERT INTO scanners
            SELECT md5(concat_ws(chr(1), ${tuple.map((name) => `coalesce(${name}, chr(0))`).join(', ')})),
              ${tuple.join(', ')}, count(*), min(created_at), max(created_at)
            FROM build_scanner_records GROUP BY ${tuple.join(', ')}`);
          await connection.exec('DROP TABLE build_scanner_records');
        }

        const policies = CANONICAL_POLICIES.filter((policy) => options.initializeCanonical || modalities.has(policy.modality));
        const canonicalBefore = options.initializeCanonical
          ? Object.fromEntries(policies.map((policy) => [policy.id, 0]))
          : await canonicalCounts(connection, policies);
        let canonicalAfter: Record<string, number> = { ...canonicalBefore };
        const recomputed: Modality[] = [];
        const computed = await canonicalIsComputed(connection);

        if (policies.length === 0) {
          if (units.length === 0) log('  nothing new');
        } else if (dryRun) {
          log(`  would recompute ${policies.map((policy) => policy.id).join(', ')}`);
        } else if (!computed) {
          log(
            '  ! this database loaded its canonical tables from the Parquet artifacts,' +
              ' so they cannot be recomputed here; rebuild without --canonical-from-parquet',
          );
        } else {
          for (const policy of policies) {
            await materializePolicy(connection, policy, { log });
            if (!recomputed.includes(policy.modality)) recomputed.push(policy.modality);
          }
          canonicalAfter = await canonicalCounts(connection, policies);
        }

        const stamp = new Date().toISOString();
        for (const unit of units) {
          await connection.exec(
            `INSERT INTO ingest_log (
               ingested_at, source, file, sha256, collection, records,
               rows_appended, rows_replaced, rows_skipped, updated_min, updated_max,
               canonical_before, canonical_after, duration_ms, data_version
             ) VALUES (CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?,
                       CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ?, ?, ?, NULL)`,
            [
              stamp,
              source.kind,
              unit.file,
              unit.sha256,
              unit.collection,
              unit.records,
              unit.rowsAppended,
              unit.rowsReplaced,
              unit.rowsSkipped,
              unit.updatedMin,
              unit.updatedMax,
              canonicalTotal(canonicalBefore, unit.collection),
              canonicalTotal(canonicalAfter, unit.collection),
              unit.durationMs,
            ],
          );
        }

        // Hashed after the inserts, so the version is a statement about the log
        // this run leaves behind, and filled back into the rows it hashes.
        const dataVersion = touched
          ? ingestDataVersion(state.baseDataVersion, await ingestLogLines(connection))
          : state.dataVersion;
        await connection.exec(`UPDATE ingest_log SET data_version = ? WHERE data_version IS NULL`, [
          dataVersion,
        ]);
        await connection.exec(`UPDATE meta SET data_version = ?`, [dataVersion]);

        if (dryRun) {
          await connection.exec('ROLLBACK');
          log(`  rolled back; data_version would become ${dataVersion}`);
        } else {
          await connection.exec('COMMIT');
        }

        return {
          units,
          recomputed,
          canonicalBefore,
          canonicalAfter,
          previousDataVersion: state.dataVersion,
          dataVersion,
          changed: !dryRun && dataVersion !== state.dataVersion,
        };
      } catch (error) {
        await connection.exec('ROLLBACK').catch(() => undefined);
        await dropStaging(connection).catch(() => undefined);
        throw error;
      } finally {
        // Use the original configured value: current_setting formats a rounded
        // MiB value, which would lose bytes on each round trip through SET.
        await connection.exec('SET memory_limit = ?', [options.memoryLimit === undefined ? DUCKDB_MEMORY_LIMIT : String(previousMemory[0]?.['value'])]);
      }
    });

    // After the commit, and so outside the transaction: `ATTACH` cannot run inside
    // one, and a snapshot of an uncommitted database would be a snapshot of nothing.
    let snapshot: string | null = null;
    let prunedSnapshots: readonly string[] = [];
    if (outcome.changed && snapshotDir !== null) {
      const written = await db.withWriter((connection) =>
        writeSnapshot(connection, snapshotDir, outcome.dataVersion, snapshotKeep),
      );
      snapshot = written.path;
      prunedSnapshots = written.pruned;
      log(
        `  snapshot ${snapshot}` +
          `${written.pruned.length > 0 ? `, pruned ${written.pruned.join(', ')}` : ''}`,
      );
    }
    if (outcome.changed) publishDataVersion(db, outcome.dataVersion);

    const elapsedMs = Date.now() - started;
    log(
      `ingest ${dryRun ? 'dry run ' : ''}done in ${(elapsedMs / 1000).toFixed(1)} s:` +
        ` ${outcome.units.length} unit(s), data_version ${outcome.dataVersion}`,
    );
    return {
      source: source.kind,
      dryRun,
      units: outcome.units,
      recomputed: outcome.recomputed,
      canonicalBefore: outcome.canonicalBefore,
      canonicalAfter: outcome.canonicalAfter,
      previousDataVersion: outcome.previousDataVersion,
      dataVersion: outcome.dataVersion,
      snapshot,
      prunedSnapshots,
      elapsedMs,
    };
  } finally {
    await source.close().catch(() => undefined);
    for (const path of temporaries) rmSync(path, { force: true });
  }
}
