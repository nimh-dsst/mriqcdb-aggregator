/** Capture/check the frozen catalog against an available Parquet-built database. */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DUCKDB_PATH } from '../src/config.js';
import { captureColumnPolicy, readColumnPolicy, serializeColumnPolicy } from '../src/db/columns-policy.js';
import type { DbConnection, ParamValue, Row } from '../src/db/instance.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const write = args.includes('--write');
const pathIndex = args.indexOf('--database');
const path = pathIndex < 0 ? DUCKDB_PATH : resolve(process.env['INIT_CWD'] ?? process.cwd(), args[pathIndex + 1]!);
if (!existsSync(path)) {
  if (write || pathIndex >= 0) throw new Error(`database missing: ${path}`);
  console.log(`SKIP columns policy: no Parquet-built database at ${path}`);
} else {
  let db: DuckDBInstance | undefined;
  try {
    db = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
  } catch (error) {
    if (write || pathIndex >= 0 || !/used by another process|Could not set lock/i.test(String(error))) throw error;
    console.log(`SKIP columns policy: database locked; pass --database <unlocked Parquet-built file>`);
  }
  if (db !== undefined) {
    const raw = await db.connect();
    try {
      const bind = (values: readonly ParamValue[] = []) => values.map((v) => v instanceof Date ? v.toISOString() : v ?? null);
      const connection: DbConnection = {
        raw,
        async all(sql, params) { return (await raw.runAndReadAll(sql, bind(params))).getRowObjectsJS() as Row[]; },
        async exec(sql, params) { await raw.run(sql, bind(params)); },
      };
      const meta = await connection.all('SELECT source_manifest FROM meta');
      if (JSON.parse(String(meta[0]?.['source_manifest'])).fromDumps !== undefined) {
        throw new Error('columns policy must be checked against a Parquet-built database');
      }
      const actual = serializeColumnPolicy(await captureColumnPolicy(connection));
      if (write) {
        writeFileSync(new URL('../policies/columns.csv', import.meta.url), actual);
        console.log(`wrote columns.csv from ${path}`);
      } else {
        if (actual !== serializeColumnPolicy(readColumnPolicy())) throw new Error(`columns.csv differs from ${path}`);
        console.log(`columns.csv matches ${path}`);
      }
    } finally { raw.closeSync(); db.closeSync(); }
  }
}
