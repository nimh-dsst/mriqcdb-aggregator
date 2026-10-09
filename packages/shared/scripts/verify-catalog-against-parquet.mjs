/**
 * Check every id in the authored catalog against the real MRIQC parquet dumps.
 *
 * The catalog claims a column exists for a (modality, view). This opens each
 * parquet file, normalizes its column names with the same `normalizeColumnName`
 * the DuckDB build uses, and reports any id that does not resolve. Nothing may
 * ship that this prints.
 *
 *   node scripts/verify-catalog-against-parquet.mjs [dataDir]
 *
 * `dataDir` defaults to $MRIQC_DATA_DIR, then to C:/Users/licc/projects/mriqc.
 * Requires `pnpm --filter @mriqc/shared build` first: it reads the built dist.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import {
  getAuthoredCatalog,
  isDroppedColumn,
  MODALITIES,
  normalizeColumnName,
} from '../dist/index.js';

const DATA_DIR = (
  process.argv[2] ??
  process.env.MRIQC_DATA_DIR ??
  'C:/Users/licc/projects/mriqc'
).replace(/\\/g, '/');

/** (modality, view) -> the parquet file that backs it. */
const FILES = {
  'bold/raw': 'mriqc_api.bold.parquet',
  'bold/k4plus': 'mriqc_api.bold.K4+.parquet',
  'T1w/raw': 'mriqc_api.T1w.parquet',
  'T1w/k3pp': 'mriqc_api.T1w.K3++.parquet',
  'T2w/raw': 'mriqc_api.T2w.parquet',
  'T2w/k3pp': 'mriqc_api.T2w.K3++.parquet',
};

const catalog = getAuthoredCatalog();

/** The (modality, view) pairs the catalog itself declares. */
const pairs = MODALITIES.flatMap((modality) =>
  catalog.views
    .filter((v) => v.modalities.includes(modality))
    .map((v) => /** @type {const} */ ([modality, v.id])),
);

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();

/** @type {Map<string, Set<string>>} */
const columns = new Map();
/** @type {string[]} */
const problems = [];

for (const [modality, view] of pairs) {
  const key = `${modality}/${view}`;
  const file = FILES[key];
  if (file === undefined) {
    problems.push(`no parquet file mapped for ${key}`);
    continue;
  }
  const path = `${DATA_DIR}/${file}`;
  const rows = (
    await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${path}')`)
  ).getRowObjects();

  const normalized = new Set();
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const row of rows) {
    const source = String(row.column_name);
    if (isDroppedColumn(source)) continue;
    const name = normalizeColumnName(source);
    const previous = seen.get(name);
    if (previous !== undefined) {
      problems.push(`COLLISION ${key}: "${previous}" and "${source}" both normalize to "${name}"`);
    }
    seen.set(name, source);
    normalized.add(name);
  }
  columns.set(key, normalized);
  console.log(`${key.padEnd(12)} ${file.padEnd(28)} ${normalized.size} columns`);
}

/**
 * Catalog ids the DuckDB build creates rather than reads, and the source column
 * each is derived from. `manufacturer_raw` is the uploaded vendor string kept
 * beside the canonicalized `manufacturer`
 * (`packages/server/src/db/vendors.ts`), so it exists exactly where
 * `manufacturer` does.
 */
const DERIVED_FROM = { manufacturer_raw: 'manufacturer' };

/** Does `id` exist in every (modality, view) the catalog claims it for? */
function check(kind, id, modality, views) {
  const resolved = DERIVED_FROM[id] ?? id;
  for (const view of views) {
    const key = `${modality}/${view}`;
    const present = columns.get(key);
    if (present === undefined) continue;
    if (!present.has(resolved)) {
      problems.push(`MISSING ${kind} "${id}" in ${key}`);
    }
  }
}

const viewsOf = (modality) =>
  catalog.views.filter((v) => v.modalities.includes(modality)).map((v) => v.id);

let metricChecks = 0;
for (const metric of catalog.metrics) {
  for (const modality of metric.modalities) {
    check('metric', metric.id, modality, viewsOf(modality));
    metricChecks += 1;
  }
}

let fieldChecks = 0;
for (const field of catalog.fields) {
  for (const modality of field.modalities) {
    const views = field.views ?? viewsOf(modality);
    check('field', field.id, modality, views);
    fieldChecks += 1;
  }
}

console.log(
  `\nchecked ${metricChecks} metric/modality claims and ${fieldChecks} field/modality claims`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log('none missing');
}

connection.closeSync();
instance.closeSync();
