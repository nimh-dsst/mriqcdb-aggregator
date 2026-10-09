/**
 * The canonicalization policies as DuckDB views.
 *
 * See `docs/k4-bold-canonicalization.md` for K4+ and the "Reconstructed K3++
 * definition" of `docs/k3pp-structural-canonicalization.md` for K3++. Each policy
 * is one SQL file in `src/sql/canonical/`, parameterized only by two table names:
 * the raw observation table and the frozen scale table. The metric lists below are
 * the same ones the SQL files spell out, and `canonical.test.ts` asserts the two
 * have not drifted.
 *
 * The scale tables are frozen artifacts under `policies/`, committed as CSV and
 * never recomputed by ingest; recalibration is a new policy version. See
 * `policies/README.md`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Modality, View } from '@mriqc/shared';
import { PACKAGE_ROOT } from '../config.js';
import type { DbConnection } from './instance.js';
import { quoteIdent } from '../sql/filters.js';
import { fill, parseStatements } from '../sql/run.js';

/* ------------------------------------------------------------- metric lists */

/** K4+ exact metrics: admitted only when the group holds exactly one value of each. */
export const BOLD_EXACT_METRICS: readonly string[] = [
  'dummy_trs',
  'fd_num',
  'fd_perc',
  'summary_bg_n',
  'summary_fg_n',
];

/** K4+ continuous metrics, normalized by the frozen IQR. */
export const BOLD_CONTINUOUS_METRICS: readonly string[] = [
  'aor', 'aqi', 'dvars_nstd', 'dvars_std', 'dvars_vstd', 'efc', 'fber', 'fd_mean',
  'fwhm_avg', 'fwhm_x', 'fwhm_y', 'fwhm_z', 'gcor', 'gsr_x', 'gsr_y', 'snr', 'tsnr',
  'summary_bg_k', 'summary_bg_mean', 'summary_bg_median', 'summary_bg_mad',
  'summary_bg_p05', 'summary_bg_p95', 'summary_bg_stdv',
  'summary_fg_k', 'summary_fg_mean', 'summary_fg_median', 'summary_fg_mad',
  'summary_fg_p05', 'summary_fg_p95', 'summary_fg_stdv',
];

/**
 * K3++ exact fields, which must be constant inside an admitted group. Neither the
 * sizes nor the spacings are ever decisive in this corpus -- every group where one
 * varies also fails the diameter test -- and both are recorded per the policy
 * decision of 2026-10-05.
 */
export const STRUCT_EXACT_FIELDS: readonly string[] = [
  'size_x', 'size_y', 'size_z', 'spacing_x', 'spacing_y', 'spacing_z',
];

/**
 * The K3++ continuous vector: the 58 DOUBLE structural IQMs plus the four
 * `summary_*_n` counts. The counts are not decoration -- the 58 alone undershoot
 * `canonical_diameter` in 125 T1w groups and adding them closes every one.
 */
export const STRUCT_CONTINUOUS_METRICS: readonly string[] = [
  'cjv', 'cnr', 'efc', 'fber', 'fwhm_avg', 'fwhm_x', 'fwhm_y', 'fwhm_z',
  'icvs_csf', 'icvs_gm', 'icvs_wm', 'inu_med', 'inu_range', 'qi_1', 'qi_2',
  'rpve_csf', 'rpve_gm', 'rpve_wm',
  'snr_csf', 'snr_gm', 'snr_total', 'snr_wm',
  'snrd_csf', 'snrd_gm', 'snrd_total', 'snrd_wm',
  'summary_bg_k', 'summary_bg_mad', 'summary_bg_mean', 'summary_bg_median',
  'summary_bg_p05', 'summary_bg_p95', 'summary_bg_stdv',
  'summary_csf_k', 'summary_csf_mad', 'summary_csf_mean', 'summary_csf_median',
  'summary_csf_p05', 'summary_csf_p95', 'summary_csf_stdv',
  'summary_gm_k', 'summary_gm_mad', 'summary_gm_mean', 'summary_gm_median',
  'summary_gm_p05', 'summary_gm_p95', 'summary_gm_stdv',
  'summary_wm_k', 'summary_wm_mad', 'summary_wm_mean', 'summary_wm_median',
  'summary_wm_p05', 'summary_wm_p95', 'summary_wm_stdv',
  'tpm_overlap_csf', 'tpm_overlap_gm', 'tpm_overlap_wm', 'wm2max',
  'summary_bg_n', 'summary_csf_n', 'summary_gm_n', 'summary_wm_n',
];

/* ---------------------------------------------------------------- policies */

/** One canonicalization policy: its SQL, its frozen scale file, and its tolerance. */
export interface CanonicalPolicy {
  /** View-name infix, e.g. `k3pp_t1w`; the views are `v_<id>_<suffix>`. */
  readonly id: string;
  readonly modality: Modality;
  readonly view: View;
  /** The `canonical_policy` literal the views emit, matching the Parquet artifact. */
  readonly label: string;
  /** The raw observation table the policy groups. */
  readonly rawTable: string;
  /** The frozen scale table name the views read, and the CSV it is loaded from. */
  readonly scaleTable: string;
  readonly scaleFile: string;
  /** Admission tolerance on the normalized diameter. */
  readonly tolerance: number;
  readonly exact: readonly string[];
  readonly continuous: readonly string[];
  /** Distinct-vector count above which the medoid falls back to the median proxy. */
  readonly proxyLimit: number;
}

/**
 * The version every policy below is at.
 *
 * One number for all three, because the three are one decision: the K3++
 * reconstruction and the K4+ rule were frozen together with their scales
 * (`policies/README.md`). Recalibrating a scale or changing an admission rule
 * bumps it, and `meta.policies` records it per policy so a served database says
 * which version produced its canonical tables.
 */
export const CANONICAL_POLICY_VERSION = '1';

export const CANONICAL_POLICIES: readonly CanonicalPolicy[] = [
  {
    id: 'k4plus_bold',
    modality: 'bold',
    view: 'k4plus',
    label: 'K4+',
    rawTable: 'raw_bold',
    scaleTable: 'scales_k4plus_bold',
    scaleFile: 'k4plus.scales.csv',
    tolerance: 1e-6,
    exact: BOLD_EXACT_METRICS,
    continuous: BOLD_CONTINUOUS_METRICS,
    proxyLimit: 2000,
  },
  {
    id: 'k3pp_t1w',
    modality: 'T1w',
    view: 'k3pp',
    label: 'K3++-T1w',
    rawTable: 'raw_t1w',
    scaleTable: 'scales_k3pp_t1w',
    scaleFile: 'k3pp-t1w.scales.csv',
    tolerance: 0.1,
    exact: STRUCT_EXACT_FIELDS,
    continuous: STRUCT_CONTINUOUS_METRICS,
    proxyLimit: 2000,
  },
  {
    id: 'k3pp_t2w',
    modality: 'T2w',
    view: 'k3pp',
    label: 'K3++-T2w',
    rawTable: 'raw_t2w',
    scaleTable: 'scales_k3pp_t2w',
    scaleFile: 'k3pp-t2w.scales.csv',
    tolerance: 0.1,
    exact: STRUCT_EXACT_FIELDS,
    continuous: STRUCT_CONTINUOUS_METRICS,
    proxyLimit: 2000,
  },
];

/** The policy with this id, or a thrown error naming the ones that exist. */
export function policyById(id: string): CanonicalPolicy {
  const policy = CANONICAL_POLICIES.find((p) => p.id === id);
  if (policy === undefined) {
    throw new Error(`no canonical policy "${id}"; have ${CANONICAL_POLICIES.map((p) => p.id).join(', ')}`);
  }
  return policy;
}

/** The statements of one policy file, in the order they must be created. */
export const STATEMENT_ORDER: readonly string[] = [
  'normalized',
  'groups',
  'members',
  'vectors',
  'vector_cost',
  'representative',
  'canonical',
  'quarantined_raw',
];

/* ------------------------------------------------------------------- paths */

/**
 * The SQL resolves from this module's own URL, so the same code works under vitest
 * (from `src/`) and from the built output (from `dist/`); `tsc` emits no `.sql`, so
 * `scripts/copy-sql.mjs` copies `src/sql/canonical` into `dist/sql/canonical`.
 * (The statistics templates are not files; they are string constants in
 * `@mriqc/shared`, so the browser's runner can compile them too.)
 * The frozen scale CSVs are not build output at all: they
 * are committed artifacts beside the package and are read from there either way.
 */
const SQL_DIR = `${fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '')}/../sql/canonical`;
const POLICY_DIR = `${PACKAGE_ROOT.replace(/\\/g, '/')}/policies`;

/** The absolute path of one policy's SQL file. */
export function policySqlPath(policy: CanonicalPolicy): string {
  return `${SQL_DIR}/${policy.id}.sql`;
}

/** The absolute path of one policy's frozen scale CSV. */
export function policyScalePath(policy: CanonicalPolicy): string {
  return `${POLICY_DIR}/${policy.scaleFile}`;
}

/* ----------------------------------------------------------------- loading */

/** One row of a frozen scale table. */
export interface ScaleRow {
  readonly metric: string;
  readonly q25: number;
  readonly q75: number;
  readonly iqr: number;
  /** True when `iqr` is the IQR over the metric's non-zero values, the corpus IQR being 0. */
  readonly fallback: boolean;
}

/**
 * Parse a frozen scale CSV. Hand-written rather than left to DuckDB's sniffer so a
 * malformed artifact is a clear error here instead of a silently retyped column,
 * and so the same parse can be asserted in a unit test without a database.
 */
export function parseScaleCsv(text: string): ScaleRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines.shift() ?? '').split(',');
  if (header[0] !== 'metric' || header[1] !== 'q25' || header[2] !== 'q75' || header[3] !== 'iqr') {
    throw new Error(`scale CSV header must start metric,q25,q75,iqr; got "${header.join(',')}"`);
  }
  const hasFallback = header[3 + 1] === 'fallback';
  return lines.map((line) => {
    const cells = line.split(',');
    if (cells.length !== header.length) {
      throw new Error(`scale CSV row has ${cells.length} cells, header has ${header.length}: "${line}"`);
    }
    const numbers = cells.slice(1, 4).map((cell) => {
      const value = Number(cell);
      if (!Number.isFinite(value)) throw new Error(`scale CSV has a non-finite number "${cell}"`);
      return value;
    }) as [number, number, number];
    return {
      metric: cells[0] as string,
      q25: numbers[0],
      q75: numbers[1],
      iqr: numbers[2],
      fallback: hasFallback && cells[4] === 'true',
    };
  });
}

/** Read and parse one policy's frozen scale CSV. */
export function readScales(policy: CanonicalPolicy): ScaleRow[] {
  return parseScaleCsv(readFileSync(policyScalePath(policy), 'utf8'));
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Create `<scaleTable>` from the policy's frozen CSV as a table of literals.
 *
 * Inserted as SQL literals rather than read with `read_csv` so the table is exactly
 * the committed text with no sniffing, and so the views work against an in-memory
 * database with no file access.
 */
export async function createScaleTable(
  connection: DbConnection,
  policy: CanonicalPolicy,
  rows: readonly ScaleRow[] = readScales(policy),
): Promise<void> {
  const expected = new Set(policy.continuous);
  const seen = new Set(rows.map((row) => row.metric));
  const missing = [...expected].filter((metric) => !seen.has(metric));
  if (missing.length > 0) {
    throw new Error(`${policy.scaleFile} is missing ${missing.length} metrics: ${missing.join(', ')}`);
  }
  const degenerate = rows.filter((row) => expected.has(row.metric) && !(row.iqr > 0));
  if (degenerate.length > 0) {
    throw new Error(
      `${policy.scaleFile} has a non-positive iqr for ${degenerate.map((r) => r.metric).join(', ')}`,
    );
  }
  const table = quoteIdent(policy.scaleTable);
  await connection.exec(
    `CREATE OR REPLACE TABLE ${table} (
       metric VARCHAR, q25 DOUBLE, q75 DOUBLE, iqr DOUBLE, fallback BOOLEAN
     )`,
  );
  const values = rows
    .map((row) => `(${literal(row.metric)}, ${row.q25}, ${row.q75}, ${row.iqr}, ${row.fallback})`)
    .join(', ');
  await connection.exec(`INSERT INTO ${table} VALUES ${values}`);
}

/**
 * The filled statements of one policy, in creation order.
 *
 * Only the two table names are substituted, and both are quoted identifiers; `fill`
 * refuses a template with any hole left over, so nothing else can reach DuckDB.
 */
export function policyStatements(
  policy: CanonicalPolicy,
  tables: { rawTable?: string; scaleTable?: string } = {},
): Array<{ name: string; sql: string }> {
  const statements = parseStatements(readFileSync(policySqlPath(policy), 'utf8'));
  const holes = {
    raw_table: quoteIdent(tables.rawTable ?? policy.rawTable),
    scale_table: quoteIdent(tables.scaleTable ?? policy.scaleTable),
  };
  return STATEMENT_ORDER.map((name) => {
    const sql = statements.get(name);
    if (sql === undefined) throw new Error(`${policy.id}.sql has no statement "${name}"`);
    return { name, sql: fill(sql, holes) };
  });
}

/** Create every view of one policy, in dependency order. */
export async function createPolicyViews(
  connection: DbConnection,
  policy: CanonicalPolicy,
  tables: { rawTable?: string; scaleTable?: string } = {},
): Promise<void> {
  for (const { sql } of policyStatements(policy, tables)) await connection.exec(sql);
}

/** The name of one of a policy's views. */
export function policyView(policy: CanonicalPolicy, suffix: string): string {
  if (!STATEMENT_ORDER.includes(suffix)) throw new Error(`no canonical view "${suffix}"`);
  return `v_${policy.id}_${suffix}`;
}

/* --------------------------------------------------- materialized relations */

/**
 * The names the build materializes each policy into, and that `db/views.ts`
 * maps `(modality, view)` onto. Derived from the policy rather than listed, so
 * the two sides cannot drift; `canonical.test.ts` asserts they agree with the
 * view map.
 *
 * `canon_<modality>_<view>` is the historical name of the canonical table --
 * the artifact loader wrote it before the build computed it -- and keeps the
 * served relation name stable across that change.
 */
export function policyCanonTable(policy: CanonicalPolicy): string {
  return `canon_${policy.modality.toLowerCase()}_${policy.view}`;
}

/** The materialized `(group_id, group_rows, …, admitted)` table of one policy. */
export function policyGroupsTable(policy: CanonicalPolicy): string {
  return `canonical_groups_${policy.id}`;
}

/** The materialized `(group_id, id)` membership of one policy's admitted groups. */
export function policyMembersTable(policy: CanonicalPolicy): string {
  return `canonical_members_${policy.id}`;
}

/** The view id of one policy's canonical-plus-quarantined view, e.g. `k4plus_all`. */
export function policyAllViewId(policy: CanonicalPolicy): View {
  return `${policy.view}_all` as View;
}

/** The relation name of one policy's canonical-plus-quarantined view. */
export function policyAllView(policy: CanonicalPolicy): string {
  return `v_${policy.modality.toLowerCase()}_${policy.view}_all`;
}
