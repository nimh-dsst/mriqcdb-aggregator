/**
 * Validate the canonicalization policy views against the Parquet artifacts.
 *
 * Rebuilds a throwaway database from the same Parquet dumps `build:db` reads, so
 * the raw tables carry exactly the normalization the server sees, creates the three
 * policy view sets over the frozen scale tables, materializes each
 * `v_<policy>_canonical`, and diffs it against the artifact that the policy was
 * reconstructed from.
 *
 * Five checks per policy, in the order they are reported:
 *
 *   admitted groups   the admission rule picks the same set of groups
 *   group sizes       `canonical_group_rows` agrees on every shared group
 *   diameters         `canonical_diameter` agrees to 1e-9 absolute
 *   representatives   the same raw row is emitted
 *   medoid            the artifact's row carries a vector whose L1 cost equals the
 *                     group minimum to 1e-12, i.e. it is a valid medoid and the two
 *                     differ only in which member of the tie set they chose
 *
 * The first three must be 100% and the medoid rate at least 99.5%, or the harness
 * exits non-zero. Representative agreement is expected around 58% over the
 * multi-vector groups: the artifact's choice among equidistant candidates is
 * implementation-order dependent and cannot be reconstructed, so the view defines
 * the tie-break as the lowest id.
 *
 * The medoid rate is measured over the multi-vector groups, the population the
 * doc's own figures are quoted over, not over the groups whose ids differ. A small
 * fixed residual of artifact representatives -- 40 of 12,449 for T2w -- is not a
 * minimal-cost vector at all, which the doc records as "T1w 99.82%, T2w 99.68%";
 * dividing that residual by the differing ids alone would report it as a much
 * larger failure than it is.
 *
 *   pnpm --filter @mriqc/server validate:canonical
 *   pnpm --filter @mriqc/server validate:canonical -- --skip-build --policy k3pp_t2w
 *
 * It cannot be pointed at the serving database. `build:db` now computes
 * `canon_<modality>_<view>` from these views, and this harness reads that table
 * as the artifact side of every diff; it therefore builds its own throwaway
 * database with `--canonical-from-parquet`, where that table is the published
 * artifact. `--skip-build --db <file>` must likewise name a database built that
 * way, or the checks compare the views against themselves and trivially pass.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CANONICAL_POLICIES,
  createPolicyViews,
  createScaleTable,
  policyView,
  readScales,
} from '../src/db/canonical.ts';
import { MODALITY_SOURCES, buildDatabase } from '../src/db/build.ts';
import { Db } from '../src/db/instance.ts';
import { PACKAGE_ROOT } from '../src/config.ts';

/* ------------------------------------------------------------------- options */

/** The corpus audit of `docs/k3pp-structural-canonicalization.md`, to compare against. */
const DOCUMENTED = {
  k3pp_t1w: {
    rawRows: 2_340_058, groups: 694_586, admittedGroups: 639_605, admittedRows: 2_172_064,
    quarantinedGroups: 54_981, quarantinedRows: 167_994, retained: 807_599, reduction: 65.49,
  },
  k3pp_t2w: {
    rawRows: 238_441, groups: 145_602, admittedGroups: 129_845, admittedRows: 195_317,
    quarantinedGroups: 15_757, quarantinedRows: 43_124, retained: 172_969, reduction: 27.46,
  },
  k4plus_bold: {
    rawRows: 1_515_368, groups: 779_973, admittedGroups: 778_075, admittedRows: 1_509_705,
    quarantinedGroups: 1_898, quarantinedRows: 5_663, retained: 783_738, reduction: 48.28,
  },
};

function parseArgs(argv) {
  const options = {
    dbPath: resolve(PACKAGE_ROOT, 'data', 'canonical-validate.duckdb'),
    skipBuild: false,
    sample: null,
    policies: CANONICAL_POLICIES.map((p) => p.id),
    memoryLimit: null,
    threads: '8',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // pnpm forwards its own `--` separator through to the script.
    if (arg === '--') continue;
    // Relative to the package root, not the cwd: pnpm runs the script from the
    // package but it is read and typed from the repo root.
    if (arg === '--db') options.dbPath = resolve(PACKAGE_ROOT, next());
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--sample') options.sample = Number(next());
    else if (arg === '--policy') options.policies = [next()];
    else if (arg === '--memory-limit') options.memoryLimit = next();
    else if (arg === '--threads') options.threads = next();
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/**
 * About 60% of what the OS reports free, so a build running beside the live server
 * cannot push the machine into swap. `/proc/meminfo` is what this host's shell
 * exposes; a platform without it falls back to a conservative fixed limit.
 */
function defaultMemoryLimit() {
  try {
    const free = /MemFree:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (free !== null) {
      const gib = (Number(free[1]) / 1024 / 1024) * 0.6;
      if (gib >= 1) return `${Math.floor(gib * 10) / 10}GiB`;
    }
  } catch {
    // No /proc/meminfo on this platform; fall through.
  }
  return '4GiB';
}

/* --------------------------------------------------------------- formatting */

const int = (value) => Number(value).toLocaleString('en-US');
const pct = (hits, total) => (total === 0 ? '--' : `${((100 * hits) / total).toFixed(2)}%`);

/** Print rows of equal shape as an aligned table. */
function table(rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const width = (column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length));
  const line = (cells) => `  ${columns.map((c, i) => String(cells[i] ?? '').padEnd(width(c))).join('  ')}`.trimEnd();
  console.log(line(columns));
  console.log(`  ${columns.map((c) => '-'.repeat(width(c))).join('  ')}`);
  for (const row of rows) console.log(line(columns.map((c) => row[c])));
}

/* ------------------------------------------------------------------- checks */

/**
 * Everything one policy's validation produces. `failures` is the list of hard
 * failures; an empty list is a pass.
 */
async function validatePolicy(connection, policy, log) {
  const view = (suffix) => policyView(policy, suffix);
  const canon = MODALITY_SOURCES.find(
    (s) => s.modality === policy.modality && s.view === policy.view,
  );
  if (canon === undefined) throw new Error(`no artifact table for ${policy.id}`);
  const raw = policy.rawTable;
  const m = (suffix) => `mat_${policy.id}_${suffix}`;
  const timings = [];

  const step = async (label, sql) => {
    const started = Date.now();
    await connection.exec(sql);
    const seconds = (Date.now() - started) / 1000;
    timings.push({ step: label, seconds: seconds.toFixed(1) });
    log(`    ${label}: ${seconds.toFixed(1)} s`);
  };
  const one = async (sql) => (await connection.all(sql))[0] ?? {};

  /* The materializations. The view chain is eight views deep and recomputes
     the 62-metric group aggregate every time it is referenced, so everything the
     checks read more than once is pulled into a table first. The group table drops
     the 62 per-metric range columns, which are in the view for inspection and are
     not needed here. */
  await step(
    'groups',
    `CREATE OR REPLACE TABLE ${m('groups')} AS
     SELECT group_id, group_rows, distinct_vectors, nonfinite_rows, has_nonfinite,
            exact_constant, diameter, admitted
            ${policy.modality === 'bold' ? ', hmc_mode' : ''}
     FROM ${view('groups')}`,
  );
  await step(
    'vector ids',
    `CREATE OR REPLACE TABLE ${m('vectors_by_id')} AS
     SELECT group_id, id, vector_hash, vector_finite FROM ${view('normalized')}`,
  );
  await step(
    'vector costs',
    `CREATE OR REPLACE TABLE ${m('cost')} AS
     SELECT group_id, vector_hash, vector_min_id, dist_sum, canonical_selection
     FROM ${view('vector_cost')}`,
  );
  await step('canonical', `CREATE OR REPLACE TABLE ${m('canonical')} AS SELECT * FROM ${view('canonical')}`);

  /* The canonical view emits raw columns plus `canonical_*`, deliberately not the
     group id, so the group id of each emitted row is recovered the same way the
     artifact's is: by its raw id. */
  await step(
    'representatives',
    `CREATE OR REPLACE TABLE ${m('rep')} AS
     SELECT v.group_id, c.id AS view_id, c.canonical_policy, c.canonical_group_rows,
            c.canonical_distinct_vectors, c.canonical_diameter, c.canonical_selection
            ${policy.modality === 'bold' ? ', c.canonical_hmc_mode' : ''}
     FROM ${m('canonical')} c JOIN ${m('vectors_by_id')} v ON v.id = c.id`,
  );

  /* The artifact side. Its group id is not re-derived from its own provenance
     columns: every artifact row is a raw row, so joining on the id picks up the
     group id the views computed, which is the same join the audit used. */
  await step(
    'artifact',
    `CREATE OR REPLACE TABLE ${m('artifact')} AS
     SELECT v.group_id, c.id AS artifact_id, c.canonical_group_rows, c.canonical_distinct_vectors,
            c.canonical_diameter, c.canonical_selection
            ${policy.modality === 'bold' ? ', c.canonical_hmc_mode' : ''}
     FROM ${canon.table} c JOIN ${m('vectors_by_id')} v ON v.id = c.id`,
  );

  const failures = [];
  const fail = (message) => failures.push(`${policy.id}: ${message}`);

  /* ---- 1. admitted groups ---- */
  const artifactRows = Number((await one(`SELECT count(*) AS n FROM ${canon.table}`)).n);
  const joined = Number((await one(`SELECT count(*) AS n FROM ${m('artifact')}`)).n);
  if (joined !== artifactRows) {
    fail(`${artifactRows - joined} of ${artifactRows} artifact rows have no row in ${raw}`);
  }
  const admission = await one(
    `SELECT
       (SELECT count(*) FROM ${m('groups')}) AS groups,
       (SELECT count(*) FROM ${m('groups')} WHERE admitted) AS admitted,
       (SELECT count(DISTINCT group_id) FROM ${m('artifact')}) AS artifact_groups,
       (SELECT count(*) FROM ${m('groups')} g WHERE g.admitted
          AND NOT EXISTS (SELECT 1 FROM ${m('artifact')} a WHERE a.group_id = g.group_id)) AS extra,
       (SELECT count(*) FROM ${m('groups')} g WHERE NOT g.admitted
          AND EXISTS (SELECT 1 FROM ${m('artifact')} a WHERE a.group_id = g.group_id)) AS missing`,
  );
  const admitted = Number(admission.admitted);
  const artifactGroups = Number(admission.artifact_groups);
  const extra = Number(admission.extra);
  const missing = Number(admission.missing);
  if (extra !== 0 || missing !== 0 || admitted !== artifactGroups) {
    fail(`admission differs: ${admitted} admitted vs ${artifactGroups} in the artifact, ` +
      `${extra} admitted but absent, ${missing} in the artifact but not admitted`);
  }

  /* The canonical view must emit exactly one row per admitted group, labelled with
     this policy, and its `canonical_*` columns must be the group's own. */
  const emitted = await one(
    `SELECT
       (SELECT count(*) FROM ${m('canonical')}) AS emitted_rows,
       (SELECT count(DISTINCT group_id) FROM ${m('rep')}) AS emitted_groups,
       (SELECT count(*) FROM ${m('rep')} WHERE canonical_policy <> '${policy.label}') AS wrong_label,
       (SELECT count(*) FROM ${m('rep')} r JOIN ${m('groups')} g USING (group_id)
          WHERE r.canonical_group_rows <> g.group_rows
             OR r.canonical_distinct_vectors <> g.distinct_vectors
             OR r.canonical_diameter IS DISTINCT FROM g.diameter) AS wrong_columns`,
  );
  if (Number(emitted.emitted_rows) !== admitted || Number(emitted.emitted_groups) !== admitted) {
    fail(`the canonical view emits ${Number(emitted.emitted_rows)} rows over ` +
      `${Number(emitted.emitted_groups)} groups for ${admitted} admitted groups`);
  }
  if (Number(emitted.wrong_label) !== 0) fail(`${Number(emitted.wrong_label)} rows carry the wrong canonical_policy`);
  if (Number(emitted.wrong_columns) !== 0) {
    fail(`${Number(emitted.wrong_columns)} rows carry canonical_* columns that are not their group's`);
  }

  /* ---- 2 and 3. group sizes and diameters ---- */
  const shared = await one(
    `SELECT count(*) AS n,
       count(*) FILTER (WHERE g.group_rows = a.canonical_group_rows) AS size_hits,
       count(*) FILTER (WHERE g.distinct_vectors = a.canonical_distinct_vectors) AS vector_hits,
       count(*) FILTER (WHERE abs(g.diameter - a.canonical_diameter) <= 1e-9) AS diameter_hits,
       max(abs(g.diameter - a.canonical_diameter)) AS max_diameter_diff
     FROM ${m('groups')} g JOIN ${m('artifact')} a USING (group_id)`,
  );
  const sharedGroups = Number(shared.n);
  const sizeHits = Number(shared.size_hits);
  const diameterHits = Number(shared.diameter_hits);
  if (sizeHits !== sharedGroups) fail(`${sharedGroups - sizeHits} group sizes differ`);
  if (diameterHits !== sharedGroups) {
    fail(`${sharedGroups - diameterHits} diameters differ by more than 1e-9 ` +
      `(worst ${Number(shared.max_diameter_diff)})`);
  }

  /* ---- 4 and 5. representatives, and whether the artifact's is a medoid ----

     A single-vector group has no choice to make, so both rates are also reported
     over the multi-vector groups alone, which is the population the doc's figures
     ("bold 100%, T1w 99.82%, T2w 99.68%" for the medoid rule, "about 58% of
     multi-vector groups" for the id) are quoted over. The gate is the medoid rate
     over multi-vector groups: a handful of artifact representatives are genuinely
     not minimal-cost vectors, which the doc records and no tie-break can recover,
     so measuring only over the groups whose ids differ would make a fixed residual
     look like a much larger failure. */
  const representatives = await one(
    `WITH paired AS (
       SELECT a.group_id, a.artifact_id, c.view_id
       FROM ${m('artifact')} a JOIN ${m('rep')} c USING (group_id)
     ),
     minimum AS (
       SELECT group_id, min(dist_sum) AS min_dist FROM ${m('cost')} GROUP BY group_id
     ),
     costed AS (
       SELECT p.group_id, p.artifact_id, p.view_id, g.distinct_vectors,
              k.dist_sum, mn.min_dist,
              (k.dist_sum IS NOT NULL
                 AND abs(k.dist_sum - mn.min_dist) <= 1e-12 * greatest(1, abs(mn.min_dist)))
                AS artifact_is_medoid
       FROM paired p
       JOIN ${m('groups')} g USING (group_id)
       JOIN minimum mn USING (group_id)
       JOIN ${m('vectors_by_id')} v ON v.id = p.artifact_id
       LEFT JOIN ${m('cost')} k ON k.group_id = p.group_id AND k.vector_hash = v.vector_hash
     )
     SELECT
       count(*) AS n,
       count(*) FILTER (WHERE artifact_id = view_id) AS id_hits,
       count(*) FILTER (WHERE distinct_vectors > 1) AS multi,
       count(*) FILTER (WHERE distinct_vectors > 1 AND artifact_id = view_id) AS multi_id_hits,
       count(*) FILTER (WHERE distinct_vectors > 1 AND artifact_is_medoid) AS multi_is_medoid,
       count(*) FILTER (WHERE artifact_id <> view_id) AS differing,
       count(*) FILTER (WHERE artifact_id <> view_id AND artifact_is_medoid) AS differing_is_medoid,
       count(*) FILTER (WHERE dist_sum IS NULL) AS cost_missing,
       max(abs(dist_sum - min_dist)) FILTER (WHERE NOT artifact_is_medoid) AS worst_cost_gap
     FROM costed`,
  );
  const paired = Number(representatives.n);
  const idHits = Number(representatives.id_hits);
  const multi = Number(representatives.multi);
  const multiIdHits = Number(representatives.multi_id_hits);
  const multiIsMedoid = Number(representatives.multi_is_medoid);
  const differing = Number(representatives.differing);
  const differingIsMedoid = Number(representatives.differing_is_medoid);
  if (paired !== admitted) fail(`${admitted} admitted groups but ${paired} paired with the artifact`);
  if (Number(representatives.cost_missing) !== 0) {
    fail(`${Number(representatives.cost_missing)} artifact representatives carry a vector with no cost`);
  }
  if (multi > 0 && multiIsMedoid / multi < 0.995) {
    fail(`only ${pct(multiIsMedoid, multi)} of the ${multi} multi-vector groups have the ` +
      `artifact's representative at the minimal L1 cost ` +
      `(worst cost gap ${Number(representatives.worst_cost_gap)})`);
  }

  /* ---- audit numbers ---- */
  const audit = await one(
    `SELECT
       (SELECT count(*) FROM ${raw}) AS raw_rows,
       (SELECT count(DISTINCT provenance_md5sum) FROM ${raw}) AS distinct_md5,
       (SELECT count(*) FROM ${m('groups')}) AS groups,
       (SELECT count(*) FROM ${m('groups')} WHERE group_rows > 1) AS duplicate_groups,
       (SELECT sum(group_rows) FROM ${m('groups')} WHERE group_rows > 1) AS duplicate_rows,
       (SELECT count(*) FROM ${m('groups')} WHERE admitted) AS admitted_groups,
       (SELECT sum(group_rows) FROM ${m('groups')} WHERE admitted) AS admitted_rows,
       (SELECT count(*) FROM ${m('groups')} WHERE NOT admitted) AS quarantined_groups,
       (SELECT sum(group_rows) FROM ${m('groups')} WHERE NOT admitted) AS quarantined_rows,
       (SELECT max(distinct_vectors) FROM ${m('groups')} WHERE admitted) AS max_distinct_vectors,
       (SELECT max(group_rows) FROM ${m('groups')}) AS max_group_rows,
       (SELECT sum(distinct_vectors * distinct_vectors) FROM ${m('groups')} WHERE admitted) AS pair_work,
       (SELECT count(DISTINCT group_id) FROM ${m('cost')} WHERE canonical_selection = 'median_proxy')
         AS median_proxy_groups,
       (SELECT count(*) FROM ${m('groups')} WHERE NOT admitted AND has_nonfinite
          AND diameter <= ${policy.tolerance} AND exact_constant) AS q_nonfinite_only,
       (SELECT count(*) FROM ${m('groups')} WHERE NOT admitted AND NOT has_nonfinite
          AND diameter > ${policy.tolerance}) AS q_diameter_only,
       (SELECT count(*) FROM ${m('groups')} WHERE NOT admitted AND NOT exact_constant) AS q_exact`,
  );

  /* ---- hmc_mode, bold only ---- */
  let hmc = null;
  if (policy.modality === 'bold') {
    const row = await one(
      `SELECT count(*) AS n,
         count(*) FILTER (WHERE g.hmc_mode = a.canonical_hmc_mode) AS hits
       FROM ${m('groups')} g JOIN ${m('artifact')} a USING (group_id)`,
    );
    hmc = { n: Number(row.n), hits: Number(row.hits) };
    if (hmc.hits !== hmc.n) fail(`${hmc.n - hmc.hits} groups disagree on canonical_hmc_mode`);
  }

  const rawRows = Number(audit.raw_rows);
  const retained = Number(audit.admitted_groups) + Number(audit.quarantined_rows);

  return {
    policy,
    failures,
    timings,
    checks: {
      admitted, artifactGroups, extra, missing,
      sharedGroups, sizeHits, diameterHits,
      vectorHits: Number(shared.vector_hits),
      maxDiameterDiff: Number(shared.max_diameter_diff),
      paired, idHits, multi, multiIdHits, multiIsMedoid, differing, differingIsMedoid,
      worstCostGap: Number(representatives.worst_cost_gap ?? 0),
      hmc,
    },
    audit: {
      rawRows,
      distinctMd5: Number(audit.distinct_md5),
      groups: Number(audit.groups),
      duplicateGroups: Number(audit.duplicate_groups),
      duplicateRows: Number(audit.duplicate_rows),
      admittedGroups: Number(audit.admitted_groups),
      admittedRows: Number(audit.admitted_rows),
      quarantinedGroups: Number(audit.quarantined_groups),
      quarantinedRows: Number(audit.quarantined_rows),
      retained,
      reduction: (100 * (1 - retained / rawRows)),
      maxDistinctVectors: Number(audit.max_distinct_vectors),
      maxGroupRows: Number(audit.max_group_rows),
      pairWork: Number(audit.pair_work),
      medianProxyGroups: Number(audit.median_proxy_groups),
      quarantineNonfiniteOnly: Number(audit.q_nonfinite_only),
      quarantineDiameterOnly: Number(audit.q_diameter_only),
      quarantineExact: Number(audit.q_exact),
    },
  };
}

/* --------------------------------------------------------------------- main */

const options = parseArgs(process.argv.slice(2));
const memoryLimit = options.memoryLimit ?? defaultMemoryLimit();
const settings = { memory_limit: memoryLimit, threads: options.threads };
const policies = options.policies.map((id) => {
  const policy = CANONICAL_POLICIES.find((p) => p.id === id);
  if (policy === undefined) throw new Error(`unknown policy "${id}"`);
  return policy;
});

console.log(`validate-canonical: ${options.dbPath}`);
console.log(`  memory_limit ${memoryLimit}, threads ${options.threads}` +
  `${options.sample === null ? '' : `, sample ${options.sample}`}`);

const startedAll = Date.now();
if (options.skipBuild && existsSync(options.dbPath)) {
  console.log(`  reusing the existing database (${(statSync(options.dbPath).size / 2 ** 30).toFixed(2)} GiB)`);
} else {
  // The artifact side of every check below reads `canon_<modality>_<view>`, so
  // the throwaway database has to hold the *published* artifact there. A default
  // build now computes those tables from these very views, which would turn each
  // check into a comparison of the views against themselves.
  const result = await buildDatabase({
    outPath: options.dbPath,
    sample: options.sample,
    settings,
    canonicalFromParquet: true,
    log: (message) => console.log(`  build: ${message}`),
  });
  console.log(`  built in ${(result.elapsedMs / 1000).toFixed(1)} s`);
}

const db = new Db(options.dbPath, 1);
const results = [];
let peakMemoryBytes = 0;
try {
  await db.withWriter(async (connection) => {
    for (const [name, value] of Object.entries(settings)) {
      await connection.exec(`SET ${name} = '${value}'`);
    }
    for (const policy of policies) {
      console.log(`\n${policy.id}: scales and views`);
      const scales = readScales(policy);
      const fallbacks = scales.filter((row) => row.fallback);
      console.log(`    ${scales.length} frozen scales, ${fallbacks.length} fallback` +
        `${fallbacks.length === 0 ? '' : ` (${fallbacks.map((r) => r.metric).join(', ')})`}`);
      await createScaleTable(connection, policy, scales);
      await createPolicyViews(connection, policy);
      results.push(await validatePolicy(connection, policy, (line) => console.log(line)));
      // Sampled after each policy, so it is the memory DuckDB still holds rather
      // than a true peak; `memory_limit` is the hard ceiling the run stayed under.
      const held = await connection.all(
        `SELECT sum(memory_usage_bytes) AS held, sum(temporary_storage_bytes) AS spilled
         FROM duckdb_memory()`,
      );
      peakMemoryBytes = Math.max(
        peakMemoryBytes,
        Number(held[0]?.held ?? 0) + Number(held[0]?.spilled ?? 0),
      );
    }
  });
} finally {
  await db.close();
}

/* ------------------------------------------------------------------ reports */

console.log('\n== checks (admitted groups, group sizes and diameters must be 100%)\n');
table(results.map((r) => ({
  policy: r.policy.id,
  'admitted groups': `${int(r.checks.admitted)} / ${int(r.checks.artifactGroups)}`,
  admission: pct(r.checks.artifactGroups - r.checks.extra - r.checks.missing, r.checks.artifactGroups),
  'group sizes': pct(r.checks.sizeHits, r.checks.sharedGroups),
  diameters: pct(r.checks.diameterHits, r.checks.sharedGroups),
  'max diam diff': r.checks.maxDiameterDiff.toExponential(2),
  'distinct vectors': pct(r.checks.vectorHits, r.checks.sharedGroups),
  hmc_mode: r.checks.hmc === null ? '--' : pct(r.checks.hmc.hits, r.checks.hmc.n),
})));

console.log('\n== representatives (the id cannot reproduce; the medoid rate must be >= 99.5%)\n');
table(results.map((r) => ({
  policy: r.policy.id,
  'multi-vector groups': int(r.checks.multi),
  'id, all groups': pct(r.checks.idHits, r.checks.paired),
  'id, multi-vector': pct(r.checks.multiIdHits, r.checks.multi),
  'artifact is medoid': pct(r.checks.multiIsMedoid, r.checks.multi),
  'differing ids': int(r.checks.differing),
  'of those, medoid': pct(r.checks.differingIsMedoid, r.checks.differing),
  'worst cost gap': r.checks.worstCostGap.toExponential(2),
})));

console.log('\n== audit, recomputed (doc = the table in docs/k3pp-structural-canonicalization.md)\n');
const rows = [];
for (const r of results) {
  const doc = DOCUMENTED[r.policy.id];
  const line = (label, got, want, format = int) => rows.push({
    policy: r.policy.id,
    quantity: label,
    recomputed: format(got),
    doc: want === undefined ? '--' : format(want),
    agrees: want === undefined ? '--' : (format(got) === format(want) ? 'yes' : 'NO'),
  });
  line('raw rows', r.audit.rawRows, doc?.rawRows);
  line('groups', r.audit.groups, doc?.groups);
  line('admitted groups', r.audit.admittedGroups, doc?.admittedGroups);
  line('rows in admitted groups', r.audit.admittedRows, doc?.admittedRows);
  line('quarantined groups', r.audit.quarantinedGroups, doc?.quarantinedGroups);
  line('quarantined rows', r.audit.quarantinedRows, doc?.quarantinedRows);
  line('retained', r.audit.retained, doc?.retained);
  line('corpus reduction %', r.audit.reduction, doc?.reduction, (v) => Number(v).toFixed(2));
}
table(rows);

console.log('\n== medoid cost and the median-proxy fallback\n');
table(results.map((r) => ({
  policy: r.policy.id,
  'largest group (rows)': int(r.audit.maxGroupRows),
  'most distinct vectors': int(r.audit.maxDistinctVectors),
  'proxy limit': int(r.policy.proxyLimit),
  'median_proxy groups': int(r.audit.medianProxyGroups),
  'pairs compared': int(r.audit.pairWork),
})));

console.log('\n== quarantine reasons\n');
table(results.map((r) => ({
  policy: r.policy.id,
  'quarantined groups': int(r.audit.quarantinedGroups),
  'diameter only': int(r.audit.quarantineDiameterOnly),
  'non-finite only': int(r.audit.quarantineNonfiniteOnly),
  'exact field varies': int(r.audit.quarantineExact),
})));

console.log('\n== timing\n');
table(results.flatMap((r) => r.timings.map((t) => ({ policy: r.policy.id, ...t }))));
console.log(`\n  total ${((Date.now() - startedAll) / 1000).toFixed(1)} s, ` +
  `DuckDB memory held after a policy at most ${(peakMemoryBytes / 2 ** 30).toFixed(2)} GiB ` +
  `under a ${memoryLimit} limit, ` +
  `database ${(statSync(options.dbPath).size / 2 ** 30).toFixed(2)} GiB`);

const failures = results.flatMap((r) => r.failures);
if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall policies validated');
