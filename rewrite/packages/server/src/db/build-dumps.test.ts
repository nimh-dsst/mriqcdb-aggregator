import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../config.js';
import { ingest } from '../ingest/ingest.js';
import { DumpDirSource } from '../ingest/sources.js';
import { parseArgs } from './build-cli.js';
import { buildDatabase, type BuildResult } from './build.js';
import { captureColumnPolicy, createDumpSchema, parseColumnPolicy, readColumnPolicy, serializeColumnPolicy } from './columns-policy.js';
import { Db } from './instance.js';

const run = promisify(execFile);
const fixture = new URL('../../test/fixtures/dumps/', import.meta.url);

describe('dump build arguments and frozen schema', () => {
  it.each([
    ['--from-dumps', 'dumps', '--data-dir', 'parquet'],
    ['--data-dir', 'parquet', '--from-dumps', 'dumps'],
  ])('rejects mixed source flags: %j', (...args) => {
    expect(() => parseArgs(args)).toThrow('--from-dumps cannot be combined with --data-dir');
  });

  it('rejects Parquet canonical artifacts and missing dump paths', () => {
    expect(() => parseArgs(['--from-dumps', 'dumps', '--canonical-from-parquet'])).toThrow('cannot be combined');
    expect(() => parseArgs(['--from-dumps', '--out', 'x'])).toThrow('--from-dumps needs a value');
  });

  it('round-trips the frozen catalog and rejects duplicate or unsafe fields', () => {
    const rows = readColumnPolicy();
    expect(parseColumnPolicy(serializeColumnPolicy(rows))).toEqual(rows);
    expect(() => serializeColumnPolicy([...rows, rows[0]!])).toThrow('Duplicate');
    expect(() => serializeColumnPolicy([{ ...rows[0]!, duckType: 'VARCHAR); DROP TABLE meta; --' }])).toThrow('Unsafe');
    expect(() => serializeColumnPolicy([{ ...rows[0]!, jsonPath: '$.wrong' }])).toThrow('json_path');
  });

  it('creates raw and auxiliary columns with exactly the frozen names, types and nullability', async () => {
    const db = new Db(':memory:', 1);
    try {
      await db.withWriter(async (connection) => {
        const rows = readColumnPolicy();
        await createDumpSchema(connection, rows);
        for (const table of ['raw_bold', 'raw_t1w', 'raw_t2w', 'ratings', 'scanners']) {
          const described = await connection.all(`DESCRIBE ${table}`);
          expect(described.map((r) => [r['column_name'], r['column_type'], r['null']])).toEqual(
            rows.filter((r) => r.table === table).map((r) => [r.column, r.duckType, r.nullable ? 'YES' : 'NO']),
          );
        }
        expect((await connection.all('SELECT count(*) AS n FROM columns'))[0]?.['n']).toBe(455n);
      });
    } finally { await db.close(); }
  });
});

describe('database from August extended-JSON fixture', () => {
  let directory: string;
  let dumps: string;
  let result: BuildResult;
  let db: Db;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mriqc-dump-build-test-'));
    dumps = join(directory, 'dumps');
    cpSync(fixture, dumps, { recursive: true });
    result = await buildDatabase({ fromDumps: dumps, outPath: join(directory, 'fixture.duckdb'),
      settings: { memory_limit: '1GiB', threads: '2' }, log: () => undefined });
    console.log(`dump fixture build: ${result.elapsedMs} ms (300 documents per collection)`);
    db = new Db(result.path, 1);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('adopts all four files and builds canonical rows, scanner metadata and a serving catalog', async () => {
    const manifest = JSON.parse(readFileSync(join(dumps, 'manifest.json'), 'utf8'));
    expect(manifest.files).toHaveLength(4);
    expect(manifest.files.every((f: { records: number }) => f.records === 300)).toBe(true);
    for (const table of ['raw_bold', 'raw_t1w', 'raw_t2w', 'ratings']) expect(result.counts.get(table)).toBe(300);
    expect(result.counts.get('canon_bold_k4plus')).toBe(267);
    expect(result.counts.get('canon_t1w_k3pp')).toBe(276);
    expect(result.counts.get('canon_t2w_k3pp')).toBe(264);
    expect(result.counts.get('scanners')).toBeGreaterThan(0);
    expect(result.dataVersion).toMatch(/^[a-f0-9]{64}$/);
    await db.withRead(async (connection) => {
      expect(await captureColumnPolicy(connection)).toEqual(readColumnPolicy());
      expect((await connection.all('SELECT sum(n_records) AS n FROM scanners'))[0]?.['n']).toBe(900n);
      const meta = (await connection.all('SELECT * FROM meta'))[0]!;
      expect(meta['data_version']).toBe(result.dataVersion);
      expect(meta['base_data_version']).not.toBe(result.dataVersion);
      const policies = JSON.parse(String(meta['policies']));
      expect(policies.canonicalSource).toBe('views');
      expect(policies.policies).toHaveLength(3);
      expect(policies.views.T1w.map((v: { view: string }) => v.view)).toContain('k3pp_all');
      expect((await connection.all('SELECT count(DISTINCT sha256) AS n FROM ingest_log'))[0]?.['n']).toBe(4n);
    });
  });

  it('a second real ingest CLI run skips all sha256s and preserves data_version', async () => {
    await db.close();
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/ingest/ingest-cli.ts',
      '--dumps', dumps, '--no-snapshot'], {
      cwd: PACKAGE_ROOT, env: { ...process.env, DUCKDB_PATH: result.path },
    });
    expect(stdout.match(/already in ingest_log/g)).toHaveLength(4);
    expect(stdout).toContain('0 unit(s)');
    db = new Db(result.path, 1);
    await db.withRead(async (connection) => {
      expect((await connection.all('SELECT data_version FROM meta'))[0]?.['data_version']).toBe(result.dataVersion);
      expect((await connection.all('SELECT count(*) AS n FROM ingest_log'))[0]?.['n']).toBe(4n);
    });
  }, 30_000);

  it('samples first N documents across files per collection without falsely marking partial files complete', async () => {
    const sampleDumps = join(directory, 'sample-dumps');
    cpSync(fixture, sampleDumps, { recursive: true });
    const firstPath = join(sampleDumps, 'mriqc_api.T1w.20260817T000000.json');
    const documents = JSON.parse(readFileSync(firstPath, 'utf8')) as unknown[];
    writeFileSync(firstPath, JSON.stringify(documents.slice(0, 2)));
    writeFileSync(join(sampleDumps, 'mriqc_api.T1w.20260818T000000.json'), JSON.stringify(documents.slice(2)));
    const sampled = await buildDatabase({ fromDumps: sampleDumps, sample: 5,
      outPath: join(directory, 'sample.duckdb'), settings: { memory_limit: '1GiB', threads: '2' }, log: () => undefined });
    const sampleDb = new Db(sampled.path, 1);
    try {
      for (const table of ['raw_bold', 'raw_t1w', 'raw_t2w', 'ratings']) expect(sampled.counts.get(table)).toBe(5);
      expect(sampled.dataVersion).not.toBe(result.dataVersion);
      await sampleDb.withRead(async (connection) => {
        expect((await connection.all('SELECT count(*) AS n FROM ingest_log WHERE sha256 IS NULL'))[0]?.['n']).toBe(4n);
      });
      const resumed = await ingest({ db: sampleDb, source: new DumpDirSource(sampleDumps), snapshotDir: null, log: () => undefined });
      expect(resumed.units).toHaveLength(4);
      await sampleDb.withRead(async (connection) => {
        expect((await connection.all('SELECT count(*) AS n FROM raw_t1w'))[0]?.['n']).toBe(300n);
      });
    } finally { await sampleDb.close(); }
  }, 60_000);
});
