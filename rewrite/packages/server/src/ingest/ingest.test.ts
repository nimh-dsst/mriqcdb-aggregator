/**
 * Ingest, end to end, against a database built from the synthetic Parquet fixture.
 *
 * The central assertion is the round trip: every row of `raw_t2w` is read back
 * out, re-expressed as the extended JSON a dump carries, and ingested with a
 * newer `_updated`. Each row must come back byte-identical except for
 * `updated_at` -- which is the doc's "a record ingested from a dump is
 * byte-identical to one loaded from Parquet", asserted on 3000 rows that include
 * NaN, +Infinity, NULL and three misspelled vendors.
 *
 * The fixture's canonical tables come from its own Parquet artifacts
 * (`testing/fixture.ts` says why), so canonical *recompute* is asserted in
 * `ingest-canonical.test.ts` against a hand-built policy corpus instead. What is
 * asserted here is that this database reports its canonical counts and declines
 * to recompute what it cannot.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUCKDB_MEMORY_LIMIT, INGEST_MEMORY_LIMIT } from '../config.js';
import type { Row } from '../db/instance.js';
import { makeFixture, type Fixture } from '../testing/fixture.js';
import {
  recordsFromTable,
  writeDumpDir,
  type ExtendedJsonValue,
} from '../testing/ingest-fixture.js';
import { ingest } from './ingest.js';
import { RecordsSource, type IngestSource } from './sources.js';

/** A temp directory per suite, removed afterwards. */
function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `mriqc-${prefix}-`)).replace(/\\/g, '/');
}

/** `SELECT *` from a table, ordered, as plain rows. */
async function rowsOf(fixture: Fixture, table: string, where = 'TRUE'): Promise<Row[]> {
  return fixture.db.withRead((connection) =>
    connection.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`),
  );
}

async function countOf(fixture: Fixture, table: string): Promise<number> {
  const rows = await fixture.db.withRead((connection) =>
    connection.all(`SELECT count(*) AS n FROM ${table}`),
  );
  return Number(rows[0]?.['n'] ?? 0);
}

async function metaVersion(fixture: Fixture): Promise<string> {
  const rows = await fixture.db.withRead((connection) =>
    connection.all(`SELECT data_version AS v FROM meta`),
  );
  return String(rows[0]?.['v'] ?? '');
}

/** A brand-new T2w record, in the shape a dump carries. */
function newT2w(
  n: number,
  overrides: Record<string, ExtendedJsonValue> = {},
): Record<string, ExtendedJsonValue> {
  return {
    _id: { $oid: `t2w-new-${String(n).padStart(3, '0')}` },
    _created: { $date: '2026-10-01T00:00:00.000Z' },
    _updated: { $date: `2026-10-0${String((n % 8) + 1)}T00:00:00.000Z` },
    provenance: { md5sum: `md5-new-${n}`, version: '24.0.0', settings: { fd_thres: 0.5 } },
    bids_meta: {
      // A Siemens variant the frozen mapping must collapse: trailing legal
      // suffix, wrong case and padding all at once.
      Manufacturer: '  siemens HEALTHINEERS  ',
      ManufacturersModelName: 'Prisma',
      MagneticFieldStrength: 3,
      InstitutionName: 'Institute 9',
      ProtocolName: 'Protocol-9',
      task_id: 'task9',
      EchoTime: 0.031,
      RepetitionTime: 2.5,
      FlipAngle: 31,
    },
    size_x: { $numberLong: '66' },
    summary_bg_n: { $numberLong: '9999' },
    spacing_x: 3.5,
    cjv: 1.25,
    efc: 2.5,
    fber: 3.5,
    qi_1: 4.5,
    ...overrides,
  };
}

/* ----------------------------------------------------- normalization equality */

describe('ingest memory headroom', () => {
  let dir: string;
  let fixture: Fixture;
  beforeAll(async () => {
    dir = temp('ingest-memory');
    fixture = await makeFixture(dir);
  }, 120_000);
  afterAll(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['commit', 'dry run', 'failure'] as const)('raises and restores after %s', async (mode) => {
    const readLimit = () => fixture.db.withRead(async (c) =>
      (await c.all(`SELECT current_setting('memory_limit') AS value`))[0]?.['value']);
    await fixture.db.withWriter((c) => c.exec('SET memory_limit = ?', [INGEST_MEMORY_LIMIT]));
    const raised = await readLimit();
    await fixture.db.withWriter((c) => c.exec('SET memory_limit = ?', [DUCKDB_MEMORY_LIMIT]));
    const before = await readLimit();
    let observed = false;
    const source: IngestSource = {
      kind: 'dumps', describe: () => 'memory test', close: async () => undefined,
      async *units() {
        expect(await readLimit()).toBe(raised);
        observed = true;
        if (mode === 'failure') throw new Error('injected source failure');
        yield* [];
      },
    };
    const run = ingest({ db: fixture.db, source, dryRun: mode === 'dry run', snapshotDir: null, log: () => undefined });
    if (mode === 'failure') await expect(run).rejects.toThrow('injected source failure');
    else await run;
    expect(observed).toBe(true);
    expect(await readLimit()).toBe(before);
  });
});

describe('a dump record lands byte-identical to a Parquet-loaded one', () => {
  let dir: string;
  let fixture: Fixture;

  beforeAll(async () => {
    dir = temp('ingest-rt');
    fixture = await makeFixture(dir);
  }, 120_000);

  afterAll(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces all 3000 rows of raw_t2w, every column but updated_at', async () => {
    const before = await rowsOf(fixture, 'raw_t2w');
    expect(before).toHaveLength(3000);

    // The same rows, re-expressed as a dump, with `_updated` moved on so every
    // one of them is a replacement rather than a skip.
    const records = await fixture.db.withRead((connection) =>
      recordsFromTable(connection, 'T2w', 'TRUE', (row, record) => {
        const updated = row['updated_at'] as Date;
        record['_updated'] = {
          $date: new Date(updated.getTime() + 86_400_000).toISOString(),
        };
      }),
    );
    expect(records).toHaveLength(3000);

    const dumps = temp('ingest-rt-dumps');
    writeDumpDir(dumps, [{ collection: 'T2w', records }]);
    const result = await ingest({
      db: fixture.db,
      dumpsDir: dumps,
      snapshotDir: null,
      log: () => undefined,
    });

    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.rowsAppended).toBe(0);
    expect(result.units[0]?.rowsReplaced).toBe(3000);
    expect(result.units[0]?.rowsSkipped).toBe(0);

    const after = await rowsOf(fixture, 'raw_t2w');
    expect(after).toHaveLength(3000);
    for (const [index, row] of after.entries()) {
      const original = before[index] as Row;
      expect(row['id']).toBe(original['id']);
      const { updated_at: newUpdated, ...rest } = row;
      const { updated_at: oldUpdated, ...expected } = original;
      expect(rest).toEqual(expected);
      expect((newUpdated as Date).getTime()).toBe((oldUpdated as Date).getTime() + 86_400_000);
    }
    rmSync(dumps, { recursive: true, force: true });
  }, 180_000);
});

/* ------------------------------------------------- appending, replacing, logs */

describe('a dump of new rows, a re-send and a rating', () => {
  let dir: string;
  let dumps: string;
  let snapshots: string;
  let fixture: Fixture;
  let baseVersion: string;

  beforeAll(async () => {
    dir = temp('ingest-new');
    dumps = join(dir, 'dumps');
    snapshots = join(dir, 'snapshots');
    fixture = await makeFixture(dir);
    baseVersion = await metaVersion(fixture);
  }, 120_000);

  afterAll(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends new rows, replaces a re-sent one, keeps NaN and Inf, and normalizes the vendor', async () => {
    const rawBefore = await countOf(fixture, 'raw_t2w');
    const ratingsBefore = await countOf(fixture, 'ratings');

    // An existing row, re-sent with a newer `_updated` and a changed metric.
    const resent = (
      await fixture.db.withRead((connection) =>
        recordsFromTable(connection, 'T2w', `id = 't2w-0100'`, (_row, record) => {
          record['_updated'] = { $date: '2030-01-01T00:00:00.000Z' };
          record['cjv'] = 42.5;
        }),
      )
    )[0] as Record<string, ExtendedJsonValue>;

    const records = [
      newT2w(1),
      newT2w(2, { cjv: { $numberDouble: 'NaN' } }),
      newT2w(3, { fber: { $numberDouble: 'Infinity' }, qi_1: { $numberDouble: '-Infinity' } }),
      newT2w(4, { cjv: null }),
      resent,
    ];
    const ratings = [
      {
        _id: { $oid: 'rating-new-1' },
        rating: '4',
        md5sum: 'md5-new-1',
        _etag: 'etag-new-1',
        _updated: { $date: '2026-10-08T00:00:00.000Z' },
        comment: 'looks fine',
        _created: { $date: '2026-10-08T00:00:00.000Z' },
        name: 'rater9',
      },
    ];

    writeDumpDir(dumps, [
      { collection: 'T2w', records, stamp: '20261008T000000' },
      { collection: 'rating', records: ratings, stamp: '20261008T000001' },
    ]);

    const result = await ingest({
      db: fixture.db,
      dumpsDir: dumps,
      snapshotDir: snapshots,
      log: () => undefined,
    });

    expect(result.source).toBe('dumps');
    expect(result.units).toHaveLength(2);
    const t2w = result.units.find((unit) => unit.collection === 'T2w');
    expect(t2w?.rowsAppended).toBe(4);
    expect(t2w?.rowsReplaced).toBe(1);
    expect(t2w?.rowsSkipped).toBe(0);
    expect(result.units.find((unit) => unit.collection === 'rating')?.rowsAppended).toBe(1);

    expect(await countOf(fixture, 'raw_t2w')).toBe(rawBefore + 4);
    expect(await countOf(fixture, 'ratings')).toBe(ratingsBefore + 1);

    const added = await rowsOf(fixture, 'raw_t2w', `id LIKE 't2w-new-%'`);
    expect(added).toHaveLength(4);
    // The frozen mapping collapses the misspelling, and the uploaded string is kept.
    expect(added.map((row) => row['manufacturer'])).toEqual([
      'Siemens',
      'Siemens',
      'Siemens',
      'Siemens',
    ]);
    expect(added[0]?.['manufacturer_raw']).toBe('  siemens HEALTHINEERS  ');
    // NaN, ±Infinity and NULL stay four distinct states.
    expect(added[0]?.['cjv']).toBe(1.25);
    expect(Number.isNaN(added[1]?.['cjv'] as number)).toBe(true);
    expect(added[2]?.['fber']).toBe(Number.POSITIVE_INFINITY);
    expect(added[2]?.['qi_1']).toBe(Number.NEGATIVE_INFINITY);
    expect(added[3]?.['cjv']).toBeNull();
    // Types follow the serving table, not the JSON: an integer column stays BIGINT.
    expect(added[0]?.['size_x']).toBe(66n);
    expect(added[0]?.['summary_bg_n']).toBe(9999n);
    expect(added[0]?.['echo_time']).toBe(0.031);

    const replaced = await rowsOf(fixture, 'raw_t2w', `id = 't2w-0100'`);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.['cjv']).toBe(42.5);
    expect((replaced[0]?.['updated_at'] as Date).toISOString()).toBe('2030-01-01T00:00:00.000Z');

    // One version change, recorded in meta and reported by the result.
    expect(result.previousDataVersion).toBe(baseVersion);
    expect(result.dataVersion).not.toBe(baseVersion);
    expect(await metaVersion(fixture)).toBe(result.dataVersion);

    // And a snapshot of the committed file.
    expect(result.snapshot).not.toBeNull();
    expect(existsSync(result.snapshot as string)).toBe(true);
  }, 180_000);

  it('writes the ingest_log rows the doc lists', async () => {
    const rows = await fixture.db.withRead((connection) =>
      connection.all(
        `SELECT source, file, sha256, collection, records, rows_appended, rows_replaced,
                rows_skipped, updated_min, updated_max, canonical_before, canonical_after,
                duration_ms, data_version, ingested_at
         FROM ingest_log ORDER BY collection`,
      ),
    );
    expect(rows).toHaveLength(2);
    const t2w = rows.find((row) => row['collection'] === 'T2w') as Row;
    expect(t2w['source']).toBe('dumps');
    expect(t2w['file']).toBe('mriqc_api.T2w.20261008T000000.json');
    expect(String(t2w['sha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(t2w['records'])).toBe(5);
    expect(Number(t2w['rows_appended'])).toBe(4);
    expect(Number(t2w['rows_replaced'])).toBe(1);
    expect(Number(t2w['rows_skipped'])).toBe(0);
    expect(t2w['updated_min']).toBeInstanceOf(Date);
    expect((t2w['updated_max'] as Date).toISOString()).toBe('2030-01-01T00:00:00.000Z');
    // The fixture's canonical tables came from Parquet, so the counts are reported
    // but unchanged: ingest refuses to recompute what it cannot.
    expect(Number(t2w['canonical_before'])).toBe(Number(t2w['canonical_after']));
    expect(Number(t2w['duration_ms'])).toBeGreaterThanOrEqual(0);
    expect(t2w['data_version']).toBe(await metaVersion(fixture));
    expect(t2w['ingested_at']).toBeInstanceOf(Date);

    const rating = rows.find((row) => row['collection'] === 'rating') as Row;
    // Ratings belong to no policy, so there is nothing canonical to report.
    expect(rating['canonical_before']).toBeNull();
  });

  it('is a no-op the second time: the file is already in ingest_log', async () => {
    const version = await metaVersion(fixture);
    const rows = await countOf(fixture, 'raw_t2w');
    const logged: string[] = [];
    const again = await ingest({
      db: fixture.db,
      dumpsDir: dumps,
      snapshotDir: snapshots,
      log: (message) => logged.push(message),
    });
    expect(again.units).toHaveLength(0);
    expect(again.dataVersion).toBe(version);
    expect(again.snapshot).toBeNull();
    expect(await countOf(fixture, 'raw_t2w')).toBe(rows);
    expect(await metaVersion(fixture)).toBe(version);
    expect(logged.join('\n')).toMatch(/already in ingest_log/);
    expect(await countOf(fixture, 'ingest_log')).toBe(2);
  }, 120_000);

  it('leaves data_version alone when a new file carries nothing new', async () => {
    const version = await metaVersion(fixture);
    // A different file name, so a different digest, holding records the database
    // already has at the same `_updated`.
    const records = await fixture.db.withRead((connection) =>
      recordsFromTable(connection, 'T2w', `id LIKE 't2w-new-%'`),
    );
    writeDumpDir(join(dir, 'again'), [
      { collection: 'T2w', records, stamp: '20261009T000000' },
    ]);
    const result = await ingest({
      db: fixture.db,
      dumpsDir: join(dir, 'again'),
      snapshotDir: snapshots,
      log: () => undefined,
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.rowsAppended).toBe(0);
    expect(result.units[0]?.rowsReplaced).toBe(0);
    expect(result.units[0]?.rowsSkipped).toBe(4);
    expect(result.dataVersion).toBe(version);
    expect(result.snapshot).toBeNull();
  }, 120_000);

  it('keeps only the newest three snapshots', async () => {
    // Three further version-moving ingests, so five snapshots have been asked for.
    for (const n of [10, 11, 12]) {
      const dumpDir = join(dir, `dumps-${n}`);
      writeDumpDir(dumpDir, [
        { collection: 'T2w', records: [newT2w(n)], stamp: `2026101${n - 10}T000000` },
      ]);
      const result = await ingest({
        db: fixture.db,
        dumpsDir: dumpDir,
        snapshotDir: snapshots,
        log: () => undefined,
      });
      expect(result.snapshot).not.toBeNull();
    }
    const kept = readdirSync(snapshots).filter((name) => /^mriqc-[0-9a-f]+\.duckdb$/.test(name));
    expect(kept).toHaveLength(3);
    expect(kept).toContain(`mriqc-${await metaVersion(fixture)}.duckdb`);
  }, 300_000);
});

/* ---------------------------------------------------------------- dry run */

describe('--dry-run', () => {
  let dir: string;
  let fixture: Fixture;

  beforeAll(async () => {
    dir = temp('ingest-dry');
    fixture = await makeFixture(dir);
  }, 120_000);

  afterAll(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures what would change and changes nothing', async () => {
    const version = await metaVersion(fixture);
    const rows = await countOf(fixture, 'raw_t2w');
    const dumps = join(dir, 'dumps');
    writeDumpDir(dumps, [{ collection: 'T2w', records: [newT2w(1), newT2w(2)] }]);

    const logged: string[] = [];
    const result = await ingest({
      db: fixture.db,
      dumpsDir: dumps,
      dryRun: true,
      snapshotDir: join(dir, 'snapshots'),
      log: (message) => logged.push(message),
    });

    expect(result.dryRun).toBe(true);
    expect(result.units[0]?.rowsAppended).toBe(2);
    expect(result.dataVersion).not.toBe(version);
    expect(logged.join('\n')).toMatch(/rolled back/);
    expect(logged.join('\n')).toMatch(/would recompute k3pp_t2w/);

    // Nothing landed: not the rows, not the version, not the log, not a snapshot.
    expect(await countOf(fixture, 'raw_t2w')).toBe(rows);
    expect(await metaVersion(fixture)).toBe(version);
    expect(result.snapshot).toBeNull();
    expect(existsSync(join(dir, 'snapshots'))).toBe(false);
    const logRows = await fixture.db.withRead((connection) =>
      connection.all(
        `SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'ingest_log'`,
      ),
    );
    expect(Number(logRows[0]?.['n'])).toBe(0);
  }, 180_000);
});

/* ------------------------------------------------- the two sources agree */

describe('the dump source and an in-memory source produce the same rows', () => {
  let dirA: string;
  let dirB: string;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    dirA = temp('ingest-src-a');
    dirB = temp('ingest-src-b');
    a = await makeFixture(dirA);
    b = await makeFixture(dirB);
  }, 240_000);

  afterAll(async () => {
    await a.close();
    await b.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('is the same table afterwards, down to the NaN', async () => {
    const records = [
      newT2w(1),
      newT2w(2, { cjv: { $numberDouble: 'NaN' } }),
      newT2w(3, { fber: { $numberDouble: 'Infinity' } }),
    ];

    const dumps = join(dirA, 'dumps');
    writeDumpDir(dumps, [{ collection: 'T2w', records }]);
    const viaFile = await ingest({
      db: a.db,
      dumpsDir: dumps,
      snapshotDir: null,
      log: () => undefined,
    });

    // The shape `MongoSource` reduces to once the driver has handed over a page.
    const viaDriver = await ingest({
      db: b.db,
      source: new RecordsSource([{ collection: 'T2w', records }], 'mongo'),
      snapshotDir: null,
      log: () => undefined,
    });

    expect(viaFile.units[0]?.rowsAppended).toBe(3);
    expect(viaDriver.units[0]?.rowsAppended).toBe(3);
    expect(viaDriver.source).toBe('mongo');

    const fromFile = await rowsOf(a, 'raw_t2w', `id LIKE 't2w-new-%'`);
    const fromDriver = await rowsOf(b, 'raw_t2w', `id LIKE 't2w-new-%'`);
    expect(fromDriver).toEqual(fromFile);

    // The log rows differ exactly where the doc says they should: a file has a
    // digest, a page has an `_updated` window and a record count instead.
    const log = async (fixture: Fixture): Promise<Row[]> =>
      fixture.db.withRead((connection) =>
        connection.all(`SELECT source, file, sha256, records, updated_max FROM ingest_log`),
      );
    const fileLog = (await log(a))[0] as Row;
    const driverLog = (await log(b))[0] as Row;
    expect(fileLog['source']).toBe('dumps');
    expect(String(fileLog['sha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(driverLog['source']).toBe('mongo');
    expect(driverLog['sha256']).toBeNull();
    expect(driverLog['file']).toBeNull();
    expect(Number(driverLog['records'])).toBe(3);
    expect(driverLog['updated_max']).toEqual(fileLog['updated_max']);
  }, 240_000);
});

/* ------------------------------------------------------------- bad input */

describe('a malformed dump directory', () => {
  it('reports a manifest that is not JSON rather than ingesting nothing quietly', async () => {
    const dir = temp('ingest-bad');
    const fixture = await makeFixture(dir);
    try {
      const dumps = join(dir, 'dumps');
      writeDumpDir(dumps, [{ collection: 'T2w', records: [newT2w(1)] }]);
      writeFileSync(join(dumps, 'manifest.json'), '{ not json');
      await expect(
        ingest({ db: fixture.db, dumpsDir: dumps, snapshotDir: null, log: () => undefined }),
      ).rejects.toThrow(/not valid JSON/);
      // The failure rolled back, so the table is untouched and no log row landed.
      expect(await countOf(fixture, 'raw_t2w')).toBe(3000);
    } finally {
      await fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
