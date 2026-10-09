/**
 * Parquet directory to DuckDB file.
 *
 * See `docs/backend-graph.md`, "Serving schema" and "Ingest". The build reads the
 * flattened dumps named by `MRIQC_DATA_DIR`, normalizes every column name once so
 * no query ever quotes a dotted identifier, unifies the types that differ between
 * modalities, and writes `meta` with the `data_version` that is the ETag of every
 * response. It writes to a temporary file and renames over the target, so a failed
 * or concurrent build never leaves a half-written database behind.
 *
 * The canonical tables are *computed*, not read: each policy of `db/canonical.ts`
 * is created as its view chain over the freshly loaded raw table and the frozen
 * scale CSV, and its `canonical` view is materialized into `canon_<modality>_<view>`
 * inside the same writer transaction as the raw load. The Parquet artifacts are
 * then only a check -- their row counts are compared against what the policy
 * admitted -- and `--canonical-from-parquet` loads them instead, for comparing the
 * two side by side.
 *
 * One column is rewritten rather than copied: the free-text vendor string becomes
 * `manufacturer_raw`, and `manufacturer` gets the canonical spelling from the
 * frozen `policies/vendors.csv` (`db/vendors.ts`, `policies/README.md`). The
 * mapping's content hash is part of `data_version`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Modality, View } from '@mriqc/shared';
import { isDroppedColumn, normalizeColumnName, viewsFor } from '@mriqc/shared';
import { DUCKDB_PATH, MRIQC_DATA_DIR } from '../config.js';
import { Db, type DbConnection } from './instance.js';
import {
  CANONICAL_POLICIES,
  CANONICAL_POLICY_VERSION,
  createPolicyViews,
  createScaleTable,
  policyAllView,
  policyCanonTable,
  policyGroupsTable,
  policyMembersTable,
  policyView,
  readScales,
  type CanonicalPolicy,
  type ScaleRow,
} from './canonical.js';
import {
  MANUFACTURER_COLUMN,
  MANUFACTURER_RAW_COLUMN,
  vendorCaseSql,
  vendorMapHash,
  type VendorMap,
  readVendorMap,
} from './vendors.js';

/* --------------------------------------------------------------- source data */

/** One Parquet file that becomes one table. */
interface Source {
  readonly table: string;
  readonly file: string;
  /** Set for the six observation tables, which share one unified column schema. */
  readonly modality?: Modality;
  readonly view?: View;
}

/** The six `(modality, view)` observation tables, in the order the build loads them. */
export const MODALITY_SOURCES: readonly Source[] = [
  { table: 'raw_bold', file: 'mriqc_api.bold.parquet', modality: 'bold', view: 'raw' },
  {
    table: 'canon_bold_k4plus',
    file: 'mriqc_api.bold.K4+.parquet',
    modality: 'bold',
    view: 'k4plus',
  },
  { table: 'raw_t1w', file: 'mriqc_api.T1w.parquet', modality: 'T1w', view: 'raw' },
  { table: 'canon_t1w_k3pp', file: 'mriqc_api.T1w.K3++.parquet', modality: 'T1w', view: 'k3pp' },
  { table: 'raw_t2w', file: 'mriqc_api.T2w.parquet', modality: 'T2w', view: 'raw' },
  { table: 'canon_t2w_k3pp', file: 'mriqc_api.T2w.K3++.parquet', modality: 'T2w', view: 'k3pp' },
];

/** The three raw observation tables, which every other relation is derived from. */
export const RAW_SOURCES: readonly Source[] = MODALITY_SOURCES.filter((s) => s.view === 'raw');

/**
 * The three canonical Parquet artifacts.
 *
 * Optional: the build computes the canonical tables from the policies, so a
 * missing artifact costs only the row-count cross-check. `--canonical-from-parquet`
 * needs them and says so.
 */
export const CANONICAL_ARTIFACT_SOURCES: readonly Source[] = MODALITY_SOURCES.filter(
  (s) => s.view !== 'raw',
);

/** Catalog tables that stand on their own: no cross-modality type unification. */
export const AUX_SOURCES: readonly Source[] = [
  { table: 'k4plus_scales', file: 'mriqc_api.bold.K4+.scales.parquet' },
  { table: 'ratings', file: 'mriqc_api.rating.parquet' },
  { table: 'scanners', file: 'scanners.parquet' },
];

/** Every Parquet file the build reads, and so every file `data_version` hashes. */
export const ALL_SOURCES: readonly Source[] = [...MODALITY_SOURCES, ...AUX_SOURCES];

/* ------------------------------------------------------------ type unification */

/** One column as `DESCRIBE` reports it. */
export interface SourceColumn {
  readonly name: string;
  readonly type: string;
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

const FLOAT_TYPES = new Set(['FLOAT', 'REAL', 'DOUBLE']);

function isIntegerType(type: string): boolean {
  return INTEGER_TYPES.has(type);
}

function isNumericType(type: string): boolean {
  return isIntegerType(type) || FLOAT_TYPES.has(type) || type.startsWith('DECIMAL');
}

/** Widening never loses a value; narrowing to an integer type might, so it is `TRY_CAST`. */
function isNarrowing(from: string, to: string): boolean {
  return isIntegerType(to) && !isIntegerType(from);
}

const BIDS_META_PREFIX = 'bids_meta.';

/**
 * The unified DuckDB type for one normalized column, given every source type it
 * carries across the six observation tables.
 *
 * The rule is derived from the data, not hand-listed. A column whose sources all
 * agree keeps its type. When they disagree the disagreement is always integer
 * versus double -- the T1w dump typed as DOUBLE what bold and T2w typed as BIGINT --
 * and the source name says which reading is right:
 *
 * - a `bids_meta.` column is acquisition metadata, genuinely continuous
 *   (`FlipAngle`, `PercentSampling`, `TotalScanTimeSec`), so it unifies to DOUBLE;
 * - anything else that any modality types as an integer is an MRIQC-computed count
 *   (`size_x`, `summary_bg_n`), so it unifies to BIGINT.
 *
 * That reproduces the doc's "counts to BIGINT, IQMs and acquisition numerics to
 * DOUBLE" without a hand-typed list of 170 columns. A disagreement that is not
 * numeric falls back to VARCHAR, which every DuckDB type casts to.
 */
export function unifyType(
  normalized: string,
  sourceNames: ReadonlySet<string>,
  types: ReadonlySet<string>,
): string {
  const only = [...types];
  if (only.length === 1) return only[0] as string;
  if (only.every(isNumericType)) {
    const allBidsMeta = [...sourceNames].every((name) => name.startsWith(BIDS_META_PREFIX));
    if (allBidsMeta) return 'DOUBLE';
    return only.some(isIntegerType) ? 'BIGINT' : 'DOUBLE';
  }
  void normalized;
  return 'VARCHAR';
}

/** What every normalized column of the observation tables is, and where it came from. */
export interface ColumnPlan {
  readonly normalized: string;
  readonly sourceName: string;
  readonly duckType: string;
}

/**
 * Resolve the unified schema of the observation tables from their `DESCRIBE`
 * output alone. Dropped columns never enter the plan; a normalized-name collision
 * inside one table is a build error, not a silent overwrite.
 */
export function planColumns(
  described: ReadonlyMap<string, readonly SourceColumn[]>,
): Map<string, ColumnPlan> {
  const sourceNames = new Map<string, Set<string>>();
  const types = new Map<string, Set<string>>();

  for (const [table, columns] of described) {
    const seen = new Map<string, string>();
    for (const column of columns) {
      if (isDroppedColumn(column.name)) continue;
      const normalized = normalizeColumnName(column.name);
      const clash = seen.get(normalized);
      if (clash !== undefined) {
        throw new Error(
          `${table}: "${clash}" and "${column.name}" both normalize to "${normalized}"`,
        );
      }
      seen.set(normalized, column.name);
      (sourceNames.get(normalized) ?? sourceNames.set(normalized, new Set()).get(normalized)!).add(
        column.name,
      );
      (types.get(normalized) ?? types.set(normalized, new Set()).get(normalized)!).add(column.type);
    }
  }

  const plan = new Map<string, ColumnPlan>();
  for (const [normalized, names] of sourceNames) {
    plan.set(normalized, {
      normalized,
      // Every source name for one normalized column is the same string in this data;
      // keep the lexicographically first so the `columns` table is deterministic.
      sourceName: [...names].sort()[0] as string,
      duckType: unifyType(normalized, names, types.get(normalized) as ReadonlySet<string>),
    });
  }

  // `manufacturer_raw` is the one column the build adds rather than reads: the
  // uploaded vendor string, kept beside the canonicalized `manufacturer`
  // (`db/vendors.ts`). It shares the source name, so the `columns` table still
  // says where it came from.
  const manufacturer = plan.get(MANUFACTURER_COLUMN);
  if (manufacturer !== undefined && !plan.has(MANUFACTURER_RAW_COLUMN)) {
    plan.set(MANUFACTURER_RAW_COLUMN, {
      normalized: MANUFACTURER_RAW_COLUMN,
      sourceName: manufacturer.sourceName,
      duckType: manufacturer.duckType,
    });
  }
  return plan;
}

/* ------------------------------------------------------------------- SQL bits */

/** Quote an identifier for DuckDB, doubling any embedded quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Forward slashes only: DuckDB's `read_parquet` takes a POSIX-style path on Windows too. */
function parquetPath(dataDir: string, file: string): string {
  return `${dataDir.replace(/\\/g, '/').replace(/\/$/, '')}/${file}`;
}

/**
 * The projection that renames and retypes one source table into its normalized
 * form. A column already at its unified type is renamed only; a widening cast is
 * exact; a narrowing cast to an integer type is a `TRY_CAST` so a NaN or a
 * non-integral value becomes NULL instead of failing the whole build.
 *
 * `vendorCase`, when given, is the `CASE` expression that canonicalizes the
 * vendor string (`db/vendors.ts`). It makes `manufacturer` the one projected
 * column that is not a straight rename: the source value goes to
 * `manufacturer_raw` and the canonical one to `manufacturer`.
 *
 * Exported because ingest runs the *same* projection over its staged relation
 * (`ingest/flatten.ts`), which is why a record that arrived in a dump lands
 * byte-identical to the same record loaded from Parquet.
 */
export function projection(
  columns: readonly SourceColumn[],
  plan: ReadonlyMap<string, ColumnPlan>,
  vendorCase: string | null = null,
): {
  sql: string;
  narrowed: ColumnPlan[];
} {
  const parts: string[] = [];
  const narrowed: ColumnPlan[] = [];
  for (const column of columns) {
    if (isDroppedColumn(column.name)) continue;
    const normalized = normalizeColumnName(column.name);
    const target = plan.get(normalized);
    if (target === undefined) throw new Error(`no plan for column ${column.name}`);
    const source = quoteIdent(column.name);
    if (normalized === MANUFACTURER_COLUMN && vendorCase !== null) {
      parts.push(`${vendorCase} AS ${quoteIdent(MANUFACTURER_COLUMN)}`);
      parts.push(`CAST(${source} AS VARCHAR) AS ${quoteIdent(MANUFACTURER_RAW_COLUMN)}`);
      continue;
    }
    if (column.type === target.duckType) {
      parts.push(`${source} AS ${quoteIdent(normalized)}`);
    } else if (isNarrowing(column.type, target.duckType)) {
      narrowed.push(target);
      parts.push(`TRY_CAST(${source} AS ${target.duckType}) AS ${quoteIdent(normalized)}`);
    } else {
      parts.push(`CAST(${source} AS ${target.duckType}) AS ${quoteIdent(normalized)}`);
    }
  }
  return { sql: parts.join(',\n  '), narrowed };
}

/* --------------------------------------------------------------- data version */

interface ManifestEntry {
  readonly file: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/**
 * `data_version` is a hash of what the build read and the policies it read them
 * under, so it changes exactly when a rebuild would change what queries return.
 * The sample size is part of it: a 20 000-row development build answers
 * differently from a full one and must not share its version. So is where the
 * canonical tables came from: the policy views and the Parquet artifacts agree
 * on the admitted set but not on every tie-broken representative row, so the two
 * builds answer differently and must not share a version.
 *
 * So is the frozen vendor mapping (`policies/vendors.csv`): it rewrites the
 * `manufacturer` column, so editing it changes every grouped and filtered answer
 * and must invalidate the catalog cache and every ETag.
 */
export function dataVersionOf(
  manifest: readonly ManifestEntry[],
  policyIds: readonly string[],
  sample: number | null,
  canonicalSource: CanonicalSource = 'views',
  vendorsHash: string = vendorMapHash(),
): string {
  const lines = [
    ...manifest.map((e) => `file ${e.file} ${e.bytes} ${Math.floor(e.mtimeMs)}`).sort(),
    ...policyIds.map((p) => `policy ${p}`).sort(),
    `sample ${sample ?? 'all'}`,
    `canonical ${canonicalSource}`,
    `vendors ${vendorsHash}`,
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/* ----------------------------------------------------------------- the build */

/**
 * Where the canonical tables come from: computed from the policy views over the
 * freshly loaded raw tables, or loaded from the Parquet artifacts.
 */
export type CanonicalSource = 'views' | 'parquet';

/** What the build recorded about one policy, written to `meta.policies`. */
export interface PolicyRecord {
  /** The policy id of `db/canonical.ts`, e.g. `k4plus_bold`. */
  readonly id: string;
  /** Policy version. Bumped when the rule or the frozen scales change. */
  readonly version: string;
  readonly modality: Modality;
  /** The canonical-only view id this policy serves, e.g. `k4plus`. */
  readonly view: View;
  /** The policy label the canonical rows carry, e.g. `K4+`. */
  readonly label: string;
  /** The frozen scale table the views read, loaded from `policies/<scaleFile>`. */
  readonly scaleTable: string;
  readonly scaleFile: string;
  /** The `data_version` of the raw tables the policy was applied to. */
  readonly dataVersion: string;
  readonly source: CanonicalSource;
  /** Admitted groups, which is also the canonical table's row count. */
  readonly admittedGroups: number;
  /**
   * Raw rows those groups collapsed, and what the policy refused. Null for a
   * Parquet-artifact build, which carries no admission decision per raw row and
   * so knows nothing about the quarantine -- "null" rather than "0", so the
   * dashboard can tell "nothing quarantined" from "not computed".
   */
  readonly admittedRows: number | null;
  readonly quarantinedGroups: number | null;
  readonly quarantinedRows: number | null;
}

/** Options for {@link buildDatabase}. Every one has a configured default. */
export interface BuildOptions {
  /** Parquet directory; defaults to `MRIQC_DATA_DIR`. */
  dataDir?: string;
  /** Destination DuckDB file; defaults to `DUCKDB_PATH`. */
  outPath?: string;
  /** Load only the first N rows of each observation table, for fast development builds. */
  sample?: number | null;
  /** Progress sink; defaults to `console.log`. */
  log?: (message: string) => void;
  /**
   * DuckDB settings applied to the writer before any table is created, as
   * `SET <name> = '<value>'`. The build otherwise runs on DuckDB's defaults, which
   * take 80% of physical RAM; a caller that has to share the machine -- the
   * canonicalization validation harness, running beside a live server -- passes
   * `memory_limit` and `threads` here.
   */
  settings?: Readonly<Record<string, string>>;
  /**
   * Load the canonical Parquet artifacts instead of computing the canonical
   * tables from the policies. Off by default; it exists so the two can be built
   * side by side and compared. A build in this mode serves no `_all` view,
   * because it has no admission decision per raw row to derive one from.
   */
  canonicalFromParquet?: boolean;
}

/** What a finished build reports. */
export interface BuildResult {
  readonly path: string;
  readonly dataVersion: string;
  /** Row count per table, in load order. */
  readonly counts: ReadonlyMap<string, number>;
  readonly elapsedMs: number;
  /** One record per policy, as written to `meta.policies`. */
  readonly policies: readonly PolicyRecord[];
  /** Artifact cross-check mismatches, empty when every artifact agreed or was absent. */
  readonly artifactWarnings: readonly string[];
}

async function describe(
  connection: DbConnection,
  path: string,
): Promise<readonly SourceColumn[]> {
  const rows = await connection.all(`DESCRIBE SELECT * FROM read_parquet(${quoteLiteral(path)})`);
  return rows.map((row) => ({
    name: String(row['column_name']),
    type: String(row['column_type']),
  }));
}

async function countRows(connection: DbConnection, table: string): Promise<number> {
  const rows = await connection.all(`SELECT count(*) AS n FROM ${quoteIdent(table)}`);
  return Number(rows[0]?.['n'] ?? 0);
}

/** `DESCRIBE` one existing relation, in its own column order. */
async function describeRelation(
  connection: DbConnection,
  relation: string,
): Promise<readonly SourceColumn[]> {
  const rows = await connection.all(`DESCRIBE ${quoteIdent(relation)}`);
  return rows.map((row) => ({
    name: String(row['column_name']),
    type: String(row['column_type']),
  }));
}

/**
 * The `CASE` expression that canonicalizes one Parquet file's vendor column, or
 * null when the file has no `Manufacturer` column at all.
 *
 * The distinct values come from the file itself, which is one column-pruned scan
 * of Parquet -- 35 distinct spellings across the whole 4M-row corpus -- and lets
 * the generated SQL compare exact literals only. The rule that turns a spelling
 * into a canonical vendor stays in `db/vendors.ts`, where it is unit-tested,
 * rather than being reimplemented as DuckDB string functions.
 */
async function vendorCaseFor(
  connection: DbConnection,
  path: string,
  columns: readonly SourceColumn[],
  map: VendorMap,
): Promise<string | null> {
  const column = columns.find(
    (c) => !isDroppedColumn(c.name) && normalizeColumnName(c.name) === MANUFACTURER_COLUMN,
  );
  if (column === undefined) return null;
  const rows = await connection.all(
    `SELECT DISTINCT CAST(${quoteIdent(column.name)} AS VARCHAR) AS v` +
      ` FROM read_parquet(${quoteLiteral(path)})`,
  );
  const values = rows.map((row) => (row['v'] === null || row['v'] === undefined ? null : String(row['v'])));
  return vendorCaseSql(quoteIdent(column.name), values, map);
}

/* ------------------------------------------------- canonical materialization */

/** What one policy admitted and what it refused, counted off its groups table. */
export interface PolicyCounts {
  readonly admittedGroups: number;
  readonly admittedRows: number;
  readonly quarantinedGroups: number;
  readonly quarantinedRows: number;
}

/**
 * Materialize one policy and define the two views built on it.
 *
 * The order is the dependency order, and each step is a table rather than a view
 * for a reason: the policy's view chain is eight deep and its `groups` view --
 * one aggregate over every normalized metric of every raw row -- is referenced
 * four times further down, so left as a view it would be recomputed four times.
 * Materializing it first and re-pointing the view at the table is what makes the
 * whole policy one pass over the raw table per step instead of several.
 * `canonical_groups_*` keeps the columns the chain and the validation harness
 * read, not the per-metric ranges, which are in the view for inspection.
 *
 * The quarantined view is then redefined as an anti-join against the materialized
 * membership, which is the same set -- every raw row is in exactly one group, so
 * a row is quarantined exactly when no admitted group claims it -- at the cost of
 * one scan instead of the whole chain.
 */
export async function materializePolicy(
  connection: DbConnection,
  policy: CanonicalPolicy,
  options: {
    /** Progress sink; silent by default. */
    log?: (message: string) => void;
    /** Row counts per relation created, for the build's report. */
    counts?: Map<string, number>;
    /** The raw table to apply the policy to; the policy's own by default. */
    rawTable?: string;
    /** The frozen scales; read from the committed CSV by default. */
    scales?: readonly ScaleRow[];
  } = {},
): Promise<PolicyCounts> {
  const log = options.log ?? ((): void => undefined);
  const counts = options.counts ?? new Map<string, number>();
  const rawTable = options.rawTable ?? policy.rawTable;
  const groupsTable = policyGroupsTable(policy);
  const membersTable = policyMembersTable(policy);
  const canonTable = policyCanonTable(policy);
  const raw = quoteIdent(rawTable);

  const step = async (label: string, sql: string): Promise<void> => {
    const started = Date.now();
    await connection.exec(sql);
    log(`  ${policy.id} ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  };

  await createScaleTable(connection, policy, options.scales ?? readScales(policy));
  await createPolicyViews(connection, policy, { rawTable });

  await step(
    'groups',
    `CREATE OR REPLACE TABLE ${quoteIdent(groupsTable)} AS
     SELECT group_id${policy.modality === 'bold' ? ', hmc_mode' : ''},
            group_rows, distinct_vectors, nonfinite_rows, has_nonfinite,
            exact_constant, diameter, admitted
     FROM ${quoteIdent(policyView(policy, 'groups'))}`,
  );
  // Re-point the view at its own materialization, so everything downstream reads
  // the table. DuckDB binds a view's body at query time, so the views created
  // over it a moment ago pick this up.
  await connection.exec(
    `CREATE OR REPLACE VIEW ${quoteIdent(policyView(policy, 'groups'))} AS
     SELECT * FROM ${quoteIdent(groupsTable)}`,
  );

  await step(
    'members',
    `CREATE OR REPLACE TABLE ${quoteIdent(membersTable)} AS
     SELECT group_id, id FROM ${quoteIdent(policyView(policy, 'members'))}`,
  );
  await step(
    'canonical',
    `CREATE OR REPLACE TABLE ${quoteIdent(canonTable)} AS
     SELECT * FROM ${quoteIdent(policyView(policy, 'canonical'))}`,
  );

  await connection.exec(
    `CREATE OR REPLACE VIEW ${quoteIdent(policyView(policy, 'quarantined_raw'))} AS
     SELECT r.* FROM ${raw} r
     WHERE NOT EXISTS (
       SELECT 1 FROM ${quoteIdent(membersTable)} m WHERE m.id = r.id
     )`,
  );

  // The union view: the canonical table's columns, in its order, with the
  // canonical-only ones NULL on the quarantined half. The canonical-only set is
  // the difference against the raw table rather than a name prefix, so a raw
  // column could be called `canonical_anything` without being nulled out.
  const canonColumns = await describeRelation(connection, canonTable);
  const rawColumns = new Set((await describeRelation(connection, rawTable)).map((c) => c.name));
  const canonList = canonColumns.map((c) => quoteIdent(c.name)).join(', ');
  const quarantinedList = canonColumns
    .map((c) =>
      rawColumns.has(c.name)
        ? quoteIdent(c.name)
        : `CAST(NULL AS ${c.type}) AS ${quoteIdent(c.name)}`,
    )
    .join(', ');
  await connection.exec(
    `CREATE OR REPLACE VIEW ${quoteIdent(policyAllView(policy))} AS
     SELECT ${canonList} FROM ${quoteIdent(canonTable)}
     UNION ALL
     SELECT ${quarantinedList} FROM ${quoteIdent(policyView(policy, 'quarantined_raw'))}`,
  );

  const groupRows = await connection.all(
    `SELECT count(*) FILTER (WHERE admitted) AS admitted_groups,
            count(*) FILTER (WHERE NOT admitted) AS quarantined_groups,
            sum(group_rows) FILTER (WHERE admitted) AS admitted_rows,
            sum(group_rows) FILTER (WHERE NOT admitted) AS quarantined_rows
     FROM ${quoteIdent(groupsTable)}`,
  );
  const row = groupRows[0] ?? {};
  const result = {
    admittedGroups: Number(row['admitted_groups'] ?? 0),
    admittedRows: Number(row['admitted_rows'] ?? 0),
    quarantinedGroups: Number(row['quarantined_groups'] ?? 0),
    quarantinedRows: Number(row['quarantined_rows'] ?? 0),
  };

  counts.set(groupsTable, await countRows(connection, groupsTable));
  counts.set(membersTable, await countRows(connection, membersTable));
  counts.set(canonTable, await countRows(connection, canonTable));
  log(
    `  ${policy.id}: ${result.admittedGroups.toLocaleString('en-US')} admitted groups from ` +
      `${result.admittedRows.toLocaleString('en-US')} rows, ` +
      `${result.quarantinedGroups.toLocaleString('en-US')} quarantined groups / ` +
      `${result.quarantinedRows.toLocaleString('en-US')} rows`,
  );
  return result;
}

/**
 * Report any narrowing cast that actually lost information, so "counts to BIGINT"
 * stays a claim about this data rather than an assumption. Cheap: DuckDB reads
 * only the narrowed columns out of the Parquet file.
 */
async function reportLossyNarrowing(
  connection: DbConnection,
  path: string,
  narrowed: readonly ColumnPlan[],
  log: (message: string) => void,
): Promise<void> {
  if (narrowed.length === 0) return;
  const checks = narrowed.map(
    (plan, i) =>
      `count(*) FILTER (WHERE ${quoteIdent(plan.sourceName)} IS NOT NULL` +
      ` AND (NOT isfinite(${quoteIdent(plan.sourceName)})` +
      ` OR floor(${quoteIdent(plan.sourceName)}) <> ${quoteIdent(plan.sourceName)})) AS c${i}`,
  );
  const rows = await connection.all(
    `SELECT ${checks.join(', ')} FROM read_parquet(${quoteLiteral(path)})`,
  );
  const row = rows[0] ?? {};
  narrowed.forEach((plan, i) => {
    const lost = Number(row[`c${i}`] ?? 0);
    if (lost > 0) {
      log(`  ! ${plan.normalized}: ${lost} non-integral source values lost to TRY_CAST BIGINT`);
    }
  });
}

/**
 * Delete every `<outPath>.building-*` file left by an earlier run.
 *
 * A build that throws partway -- a bad column, a cast error, a full disk, Ctrl-C --
 * leaves its temp file and WAL behind, and the next run names its own temp file
 * after a different pid, so nothing would ever reclaim them.
 */
export function removeStaleBuilds(outPath: string): string[] {
  const directory = dirname(outPath);
  if (!existsSync(directory)) return [];
  const prefix = `${basename(outPath)}.building-`;
  const removed: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    rmSync(join(directory, entry), { force: true });
    removed.push(entry);
  }
  return removed;
}

/**
 * Build the serving database. Writes a temporary file beside the destination and
 * renames it over the target only after every table is loaded, so the build is
 * idempotent and never leaves the server reading a partial file.
 */
export async function buildDatabase(options: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const dataDir = (options.dataDir ?? MRIQC_DATA_DIR).replace(/\\/g, '/');
  const outPath = options.outPath ?? DUCKDB_PATH;
  const sample = options.sample ?? null;
  const log = options.log ?? ((message: string) => console.log(message));
  const canonicalSource: CanonicalSource = options.canonicalFromParquet ? 'parquet' : 'views';

  // The canonical artifacts are optional when the build computes the canonical
  // tables itself: their absence costs only the row-count cross-check, and an
  // absent file is left out of the manifest so its absence is part of the
  // version rather than a build failure.
  const optional = new Set(
    canonicalSource === 'views' ? CANONICAL_ARTIFACT_SOURCES.map((s) => s.file) : [],
  );
  const manifest: ManifestEntry[] = [];
  const missingArtifacts: string[] = [];
  for (const source of ALL_SOURCES) {
    const path = parquetPath(dataDir, source.file);
    if (!existsSync(path)) {
      if (!optional.has(source.file)) throw new Error(`source file missing: ${path}`);
      missingArtifacts.push(source.file);
      continue;
    }
    const stat = statSync(path);
    manifest.push({ file: source.file, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (missingArtifacts.length > 0) {
    log(`canonical artifacts absent, no cross-check: ${missingArtifacts.join(', ')}`);
  }

  // What this build will actually serve, which is what `meta.policies` records
  // and the catalog reads back as `availableViews`. A Parquet-artifact build has
  // no per-row admission decision and so cannot serve the `_all` views.
  const policies = Object.fromEntries(
    (['bold', 'T1w', 'T2w'] as const).map((modality) => [
      modality,
      viewsFor(modality)
        .filter((view) => canonicalSource === 'views' || view.includesQuarantined !== true)
        .map((view) => ({ view: view.id, policy: view.policy ?? null })),
    ]),
  );
  const policyIds = Object.entries(policies).flatMap(([modality, views]) =>
    views.map((v) => `${modality}/${v.view}=${v.policy ?? 'none'}`),
  );
  // Read before anything is created, so a malformed artifact fails the build
  // before it has written a gigabyte.
  const vendorMap = readVendorMap();
  const dataVersion = dataVersionOf(
    manifest,
    policyIds,
    sample,
    canonicalSource,
    vendorMapHash(),
  );

  mkdirSync(dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.building-${process.pid}`;
  // Every leftover temp file, not just this pid's: a build that threw or was
  // interrupted used a different pid, and its multi-gigabyte partial file would
  // otherwise never be reclaimed.
  removeStaleBuilds(outPath);
  for (const stale of [tempPath, `${tempPath}.wal`]) rmSync(stale, { force: true });

  const db = new Db(tempPath, 1);
  const counts = new Map<string, number>();
  const policyRecords: PolicyRecord[] = [];
  const artifactWarnings: string[] = [];
  let loaded = false;

  try {
    await db.withWriter(async (connection) => {
      // A setting name is an identifier in DuckDB's grammar and cannot be quoted or
      // bound, so it is checked against the shape of one rather than escaped.
      for (const [name, value] of Object.entries(options.settings ?? {})) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a DuckDB setting name: ${name}`);
        await connection.exec(`SET ${name} = ${quoteLiteral(value)}`);
      }

      // One DESCRIBE per observation file resolves the unified schema before any
      // table is created; it reads Parquet metadata only. An absent canonical
      // artifact contributes nothing: the canonical-only columns then come from
      // the policy views, which emit the raw table's own types.
      const described = new Map<string, readonly SourceColumn[]>();
      for (const source of MODALITY_SOURCES) {
        const path = parquetPath(dataDir, source.file);
        if (!existsSync(path)) continue;
        described.set(source.table, await describe(connection, path));
      }
      const plan = planColumns(described);
      log(`schema: ${plan.size} normalized columns across ${described.size} observation tables`);

      const limit = sample === null ? '' : `\nLIMIT ${Math.floor(sample)}`;
      const loadedSources: Source[] = [
        ...RAW_SOURCES,
        ...(canonicalSource === 'parquet' ? CANONICAL_ARTIFACT_SOURCES : []),
      ];
      for (const source of loadedSources) {
        const path = parquetPath(dataDir, source.file);
        const columns = described.get(source.table) as readonly SourceColumn[];
        const vendorCase = await vendorCaseFor(connection, path, columns, vendorMap);
        const { sql, narrowed } = projection(columns, plan, vendorCase);
        await connection.exec(
          `CREATE TABLE ${quoteIdent(source.table)} AS\nSELECT\n  ${sql}\n` +
            `FROM read_parquet(${quoteLiteral(path)})${limit}`,
        );
        counts.set(source.table, await countRows(connection, source.table));
        log(`loaded ${source.table}: ${counts.get(source.table)} rows`);
        await reportLossyNarrowing(connection, path, narrowed, log);
      }

      // The catalog tables stand on their own: their names are normalized the same
      // way, but they describe scanners and ratings rather than observations, so
      // nothing is unified across them.
      for (const source of AUX_SOURCES) {
        const path = parquetPath(dataDir, source.file);
        const columns = await describe(connection, path);
        const parts = columns
          .filter((c) => !isDroppedColumn(c.name))
          .map((c) => `${quoteIdent(c.name)} AS ${quoteIdent(normalizeColumnName(c.name))}`);
        await connection.exec(
          `CREATE TABLE ${quoteIdent(source.table)} AS\nSELECT\n  ${parts.join(',\n  ')}\n` +
            `FROM read_parquet(${quoteLiteral(path)})`,
        );
        counts.set(source.table, await countRows(connection, source.table));
        log(`loaded ${source.table}: ${counts.get(source.table)} rows`);
      }

      await connection.exec(
        `CREATE VIEW ratings_by_md5 AS
         SELECT md5sum,
                count(*) AS n,
                avg(TRY_CAST(rating AS DOUBLE)) AS mean_rating
         FROM ratings
         WHERE md5sum IS NOT NULL
         GROUP BY md5sum`,
      );

      // The canonical half: computed from the policies, in the same writer
      // transaction as the raw load, so the database is never readable with raw
      // tables and canonical tables that disagree about what the raw rows are.
      for (const policy of CANONICAL_POLICIES) {
        if (canonicalSource === 'parquet') {
          const canonTable = policyCanonTable(policy);
          policyRecords.push({
            id: policy.id,
            version: CANONICAL_POLICY_VERSION,
            modality: policy.modality,
            view: policy.view,
            label: policy.label,
            scaleTable: policy.scaleTable,
            scaleFile: policy.scaleFile,
            dataVersion,
            source: 'parquet',
            admittedGroups: counts.get(canonTable) ?? 0,
            admittedRows: null,
            quarantinedGroups: null,
            quarantinedRows: null,
          });
          continue;
        }
        const measured = await materializePolicy(connection, policy, { log, counts });
        policyRecords.push({
          id: policy.id,
          version: CANONICAL_POLICY_VERSION,
          modality: policy.modality,
          view: policy.view,
          label: policy.label,
          scaleTable: policy.scaleTable,
          scaleFile: policy.scaleFile,
          dataVersion,
          source: 'views',
          ...measured,
        });

        // Build-time sanity: the artifact is the policy's reconstruction target,
        // so a different admitted count means the policy as implemented and the
        // policy as published have parted company. A warning, not a failure:
        // the artifact is a frozen August dump and the raw tables may have moved
        // on, and `scripts/validate-canonical.mjs` is where the five-way diff
        // lives.
        const artifact = CANONICAL_ARTIFACT_SOURCES.find(
          (s) => s.modality === policy.modality && s.view === policy.view,
        );
        const artifactPath = artifact === undefined ? null : parquetPath(dataDir, artifact.file);
        if (artifactPath !== null && existsSync(artifactPath) && sample === null) {
          const rows = await connection.all(
            `SELECT count(*) AS n FROM read_parquet(${quoteLiteral(artifactPath)})`,
          );
          const artifactRows = Number(rows[0]?.['n'] ?? 0);
          if (artifactRows !== measured.admittedGroups) {
            const warning =
              `${policy.id}: admitted ${measured.admittedGroups.toLocaleString('en-US')} rows, ` +
              `artifact ${artifact?.file} has ${artifactRows.toLocaleString('en-US')}`;
            artifactWarnings.push(warning);
            log(`  ! ${warning}`);
          } else {
            log(`  ${policy.id}: matches ${artifact?.file} at ${artifactRows.toLocaleString('en-US')} rows`);
          }
        }
      }

      await connection.exec(
        `CREATE TABLE columns (
           modality VARCHAR,
           "column" VARCHAR,
           source_name VARCHAR,
           duck_type VARCHAR
         )`,
      );
      const columnRows: string[] = [];
      const params: Array<string> = [];
      const pushColumn = (modality: string, entry: ColumnPlan): void => {
        columnRows.push('(?, ?, ?, ?)');
        params.push(modality, entry.normalized, entry.sourceName, entry.duckType);
      };
      // Read off the relations that exist, not off the Parquet schemas: the
      // canonical tables are computed now, so what a modality's columns are is
      // what its raw and canonical tables actually carry. The raw table comes
      // first, so a column shared with the canonical table is recorded at the
      // unified type the raw load gave it.
      for (const modality of ['bold', 'T1w', 'T2w'] as const) {
        const tables = MODALITY_SOURCES.filter((s) => s.modality === modality).map((s) => s.table);
        const seen = new Set<string>();
        for (const table of tables) {
          for (const column of await describeRelation(connection, table)) {
            if (seen.has(column.name)) continue;
            seen.add(column.name);
            pushColumn(modality, {
              normalized: column.name,
              sourceName: plan.get(column.name)?.sourceName ?? column.name,
              duckType: column.type,
            });
          }
        }
      }
      for (const source of AUX_SOURCES) {
        for (const column of await describe(connection, parquetPath(dataDir, source.file))) {
          pushColumn(source.table, {
            normalized: normalizeColumnName(column.name),
            sourceName: column.name,
            duckType: column.type,
          });
        }
      }
      await connection.exec(
        `INSERT INTO columns (modality, "column", source_name, duck_type) VALUES ${columnRows.join(', ')}`,
        params,
      );
      counts.set('columns', await countRows(connection, 'columns'));

      await connection.exec(
        `CREATE TABLE meta (
           data_version VARCHAR,
           built_at TIMESTAMP,
           source_manifest VARCHAR,
           policies VARCHAR
         )`,
      );
      await connection.exec(
        `INSERT INTO meta (data_version, built_at, source_manifest, policies)
         VALUES (?, CAST(? AS TIMESTAMP), ?, ?)`,
        [
          dataVersion,
          new Date().toISOString(),
          JSON.stringify({ dataDir, sample, files: manifest }),
          JSON.stringify({
            views: policies,
            sample,
            canonicalSource,
            policies: policyRecords,
            artifactWarnings,
          }),
        ],
      );
      counts.set('meta', 1);
      loaded = true;
    });
  } finally {
    await db.close();
    // A build that threw leaves a partial file and its WAL behind; nothing else
    // ever removes them, since the next run has a different pid.
    if (!loaded) for (const stale of [tempPath, `${tempPath}.wal`]) rmSync(stale, { force: true });
  }

  for (const stale of [outPath, `${outPath}.wal`]) rmSync(stale, { force: true });
  renameSync(tempPath, outPath);
  rmSync(`${tempPath}.wal`, { force: true });

  const elapsedMs = Date.now() - started;
  log(`built ${outPath} in ${(elapsedMs / 1000).toFixed(1)} s, data_version ${dataVersion}`);
  for (const [table, n] of counts) log(`  ${table.padEnd(30)} ${n.toLocaleString('en-US')}`);
  if (artifactWarnings.length > 0) {
    log(`artifact cross-check: ${artifactWarnings.length} mismatch(es)`);
    for (const warning of artifactWarnings) log(`  ! ${warning}`);
  }
  return { path: outPath, dataVersion, counts, elapsedMs, policies: policyRecords, artifactWarnings };
}
