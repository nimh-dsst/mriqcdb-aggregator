/** Bootstrap a serving database using only the frozen catalog and mongoexport files. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { viewsFor } from '@mriqc/shared';
import { DUCKDB_PATH } from '../config.js';
import { ingest } from '../ingest/ingest.js';
import { DumpDirSource, parseManifest } from '../ingest/sources.js';
import { type BuildOptions, type BuildResult, type PolicyRecord, quoteIdent } from './build.js';
import { CANONICAL_POLICIES, CANONICAL_POLICY_VERSION, policyGroupsTable } from './canonical.js';
import { columnPolicyHash, createDumpSchema, readColumnPolicy } from './columns-policy.js';
import { Db } from './instance.js';
import { vendorMapHash } from './vendors.js';

/** Use the dump tool's implementation verbatim: adoption must have only one definition. */
export async function adoptDumps(out: string, log: (message: string) => void): Promise<void> {
  const toolUrl = new URL('../../../../tools/mriqc-dump/src/dump.mjs', import.meta.url);
  const tool = await import(toolUrl.href) as {
    adopt(options: { out: string; log: (message: string) => void }): Promise<unknown>;
  };
  await tool.adopt({ out, log });
}

export async function buildFromDumps(options: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const log = options.log ?? console.log;
  const dumpDir = resolve(options.fromDumps!);
  const outPath = options.outPath ?? DUCKDB_PATH;
  const sample = options.sample ?? null;
  if (sample !== null && (!Number.isSafeInteger(sample) || sample <= 0)) {
    throw new Error('--sample needs a positive integer');
  }
  const catalog = readColumnPolicy();
  await adoptDumps(dumpDir, log);
  const manifest = parseManifest(readFileSync(join(dumpDir, 'manifest.json'), 'utf8'));
  if (manifest.files.length === 0) throw new Error(`no dump files in ${dumpDir}`);
  const baseVersion = createHash('sha256').update(JSON.stringify({
    source: 'dumps', sample, columns: columnPolicyHash(), vendors: vendorMapHash(),
    canonical: CANONICAL_POLICY_VERSION,
    files: manifest.files.map(({ collection, sha256 }) => `${collection}/${sha256}`).sort(),
  })).digest('hex');
  const views = Object.fromEntries((['bold', 'T1w', 'T2w'] as const).map((modality) => [
    modality, viewsFor(modality).map((view) => ({ view: view.id, policy: view.policy ?? null })),
  ]));
  mkdirSync(dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.building-${process.pid}-${Date.now()}`;
  const db = new Db(tempPath, 1);
  const counts = new Map<string, number>();
  const policyRecords: PolicyRecord[] = [];
  let dataVersion = baseVersion;
  let closed = false;
  try {
    await db.withWriter(async (connection) => {
      for (const [name, value] of Object.entries(options.settings ?? {})) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a DuckDB setting name: ${name}`);
        await connection.exec(`SET ${name} = ?`, [value]);
      }
      await createDumpSchema(connection, catalog);
      await connection.exec(`CREATE VIEW ratings_by_md5 AS SELECT md5sum, count(*) AS n,
        avg(TRY_CAST(rating AS DOUBLE)) AS mean_rating FROM ratings
        WHERE md5sum IS NOT NULL GROUP BY md5sum`);
      await connection.exec(`CREATE TABLE meta (
        data_version VARCHAR, built_at TIMESTAMP, source_manifest VARCHAR, policies VARCHAR)`);
      await connection.exec(`INSERT INTO meta VALUES (?, CAST(? AS TIMESTAMP), ?, ?)`, [
        baseVersion, new Date().toISOString(), JSON.stringify({ fromDumps: dumpDir, sample, files: manifest.files }),
        JSON.stringify({ views, sample, canonicalSource: 'views', policies: [], artifactWarnings: [] }),
      ]);
    });
    const result = await ingest({
      db, source: new DumpDirSource(dumpDir, { log }), snapshotDir: null,
      initializeCanonical: true, sample, log,
      ...(options.settings?.['memory_limit'] === undefined ? {} : { memoryLimit: options.settings['memory_limit'] }),
    });
    dataVersion = result.dataVersion;
    await db.withWriter(async (connection) => {
      await connection.exec(`INSERT INTO k4plus_scales
        SELECT metric, q25, q75, iqr FROM scales_k4plus_bold`);
      for (const policy of CANONICAL_POLICIES) {
        const rows = await connection.all(`SELECT
          count(*) FILTER (WHERE admitted) AS ag, coalesce(sum(group_rows) FILTER (WHERE admitted), 0) AS ar,
          count(*) FILTER (WHERE NOT admitted) AS qg, coalesce(sum(group_rows) FILTER (WHERE NOT admitted), 0) AS qr
          FROM ${quoteIdent(policyGroupsTable(policy))}`);
        const row = rows[0]!;
        policyRecords.push({
          id: policy.id, version: CANONICAL_POLICY_VERSION, modality: policy.modality,
          view: policy.view, label: policy.label, scaleTable: policy.scaleTable, scaleFile: policy.scaleFile,
          dataVersion, source: 'views', admittedGroups: Number(row['ag']), admittedRows: Number(row['ar']),
          quarantinedGroups: Number(row['qg']), quarantinedRows: Number(row['qr']),
        });
      }
      await connection.exec('UPDATE meta SET policies = ?', [JSON.stringify({
        views, sample, canonicalSource: 'views', policies: policyRecords, artifactWarnings: [],
      })]);
      const tables = await connection.all(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name`);
      for (const table of tables) {
        const name = String(table['table_name']);
        const rows = await connection.all(`SELECT count(*) AS n FROM ${quoteIdent(name)}`);
        counts.set(name, Number(rows[0]?.['n'] ?? 0));
      }
    });
    await db.close();
    closed = true;
    // Rename directly: if the destination is locked, preserve it and fail cleanly.
    renameSync(tempPath, outPath);
  } finally {
    if (!closed) await db.close();
    rmSync(tempPath, { force: true });
    rmSync(`${tempPath}.wal`, { force: true });
  }
  const elapsedMs = Date.now() - started;
  log(`built ${outPath} in ${(elapsedMs / 1000).toFixed(1)} s, data_version ${dataVersion}`);
  return { path: outPath, dataVersion, counts, elapsedMs, policies: policyRecords, artifactWarnings: [] };
}
