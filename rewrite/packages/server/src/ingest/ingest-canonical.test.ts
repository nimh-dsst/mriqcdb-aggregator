/**
 * Ingest recomputing the canonical tables.
 *
 * The shared Parquet fixture loads its canonical tables from its own artifacts
 * (`testing/fixture.ts` says why), so this suite builds the other kind: a raw
 * table holding exactly the K3++-T2w policy's own columns, hand-built groups from
 * `testing/canonical-fixture.ts`'s conventions, unit scales so a normalized
 * diameter is the raw range, and the policy materialized over it the way
 * `db/build.ts` does.
 *
 * Ingesting into that must do what the doc says: "recomputes the canonical tables
 * of every modality that received rows, under the frozen scale tables, via the
 * existing policy views, with `CREATE OR REPLACE TABLE` in the same transaction as
 * the appends". Both directions are asserted -- a new group that the policy
 * admits appears, and an existing admitted group that a new member pushes past
 * the tolerance disappears.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeColumnName } from '@mriqc/shared';
import { quoteIdent } from '../db/build.js';
import { materializePolicy } from '../db/build.js';
import { policyById, policyCanonTable, policyMembersTable } from '../db/canonical.js';
import { Db, type DbConnection, type Row } from '../db/instance.js';
import { baseOf, baseValue, unitScales } from '../testing/canonical-fixture.js';
import {
  writeDumpDir,
  type ExtendedJsonValue,
} from '../testing/ingest-fixture.js';
import { ingest } from './ingest.js';

const POLICY = policyById('k3pp_t2w');

/** The policy's full vector: its exact fields then its continuous metrics. */
const METRICS = [...POLICY.exact, ...POLICY.continuous];

/**
 * The source name each normalized column came from, which is what the `columns`
 * table records and what ingest re-nests the JSON by.
 */
const SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['id', '_id'],
  ['created_at', '_created'],
  ['updated_at', '_updated'],
  ['provenance_md5sum', 'provenance.md5sum'],
  ['provenance_version', 'provenance.version'],
  ['provenance_settings_testing', 'provenance.settings.testing'],
  // Every metric name is already snake_case, so it is its own source name.
  ...METRICS.map((metric) => [metric, metric] as const),
];

/** One member row of a hand-built group, as SQL values. */
interface Member {
  readonly id: string;
  readonly md5: string;
  readonly overrides?: Readonly<Record<string, number>>;
}

/** The value one member carries for one metric. */
function valueOf(member: Member, metric: string, index: number): number {
  return member.overrides?.[metric] ?? baseValue(metric, index);
}

/**
 * Build the serving database this suite ingests into: one raw table at the
 * policy's columns, the `columns` and `meta` rows ingest reads, and the policy
 * materialized over it.
 */
async function buildPolicyDb(path: string, members: readonly Member[]): Promise<Db> {
  const db = new Db(path, 1);
  await db.withWriter(async (connection: DbConnection) => {
    const columns = [
      'id VARCHAR',
      'created_at TIMESTAMP',
      'updated_at TIMESTAMP',
      'provenance_md5sum VARCHAR',
      'provenance_version VARCHAR',
      'provenance_settings_testing BOOLEAN',
      ...METRICS.map((metric) => `${quoteIdent(metric)} DOUBLE`),
    ];
    await connection.exec(`CREATE TABLE raw_t2w (${columns.join(', ')})`);
    const values = members.map((member, serial) => {
      const cells = [
        `'${member.id}'`,
        `TIMESTAMP '2020-01-01 00:00:00' + INTERVAL (${serial}) DAY`,
        `TIMESTAMP '2021-01-01 00:00:00' + INTERVAL (${serial}) DAY`,
        `'${member.md5}'`,
        `'23.1.0'`,
        'FALSE',
        ...METRICS.map((metric, index) => `CAST(${valueOf(member, metric, index)} AS DOUBLE)`),
      ];
      return `(${cells.join(', ')})`;
    });
    await connection.exec(`INSERT INTO raw_t2w VALUES ${values.join(', ')}`);

    await connection.exec(
      `CREATE TABLE columns (modality VARCHAR, "column" VARCHAR, source_name VARCHAR, duck_type VARCHAR)`,
    );
    const described = await connection.all(`DESCRIBE raw_t2w`);
    const sources = new Map(SOURCES);
    const rows = described.map((row) => {
      const column = String(row['column_name']);
      const source = sources.get(column);
      if (source === undefined) throw new Error(`the fixture has no source name for ${column}`);
      // The same invariant `targetColumnsOf` checks, asserted at fixture build
      // time so a drift shows up here rather than as a confusing ingest error.
      if (normalizeColumnName(source) !== column) {
        throw new Error(`${source} normalizes to ${normalizeColumnName(source)}, not ${column}`);
      }
      return `('T2w', '${column}', '${source}', '${String(row['column_type'])}')`;
    });
    await connection.exec(`INSERT INTO columns VALUES ${rows.join(', ')}`);

    await connection.exec(
      `CREATE TABLE meta (data_version VARCHAR, built_at TIMESTAMP, source_manifest VARCHAR, policies VARCHAR)`,
    );
    await connection.exec(
      `INSERT INTO meta VALUES ('base-version', CURRENT_TIMESTAMP, '{}', ?)`,
      [JSON.stringify({ canonicalSource: 'views', policies: [] })],
    );

    await materializePolicy(connection, POLICY, { scales: unitScales(POLICY) });
  });
  return db;
}

/** One dump record for a member, in the extended-JSON shape. */
function recordFor(
  member: Member,
  updated: string,
): Record<string, ExtendedJsonValue> {
  const metrics: Record<string, ExtendedJsonValue> = {};
  METRICS.forEach((metric, index) => {
    metrics[metric] = valueOf(member, metric, index);
  });
  return {
    _id: { $oid: member.id },
    _created: { $date: '2026-10-01T00:00:00.000Z' },
    _updated: { $date: updated },
    provenance: { md5sum: member.md5, version: '23.1.0', settings: { testing: false } },
    ...metrics,
  };
}

/** The `provenance_md5sum` values the canonical table currently holds. */
async function canonicalGroups(db: Db): Promise<string[]> {
  const rows = await db.withRead((connection) =>
    connection.all(
      `SELECT provenance_md5sum AS m FROM ${quoteIdent(policyCanonTable(POLICY))} ORDER BY m`,
    ),
  );
  return rows.map((row) => String(row['m']));
}

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-ingest-canon-')).replace(/\\/g, '/');
  db = await buildPolicyDb(join(dir, 'policy.duckdb'), [
    // Two identical members: one admitted group.
    { id: 'row-0001', md5: 'g-admit' },
    { id: 'row-0002', md5: 'g-admit' },
    // One member on its own: admitted, and the group the ingest will break.
    { id: 'row-0003', md5: 'g-grow' },
  ]);
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the fixture itself', () => {
  it('starts with both groups admitted', async () => {
    expect(await canonicalGroups(db)).toEqual(['g-admit', 'g-grow']);
  });
});

describe('ingest recomputes the canonical tables of the modalities it touched', () => {
  it('admits a new group and quarantines one a new member broke', async () => {
    const dumps = join(dir, 'dumps');
    writeDumpDir(dumps, [
      {
        collection: 'T2w',
        records: [
          // A new group of two identical rows: the policy admits it.
          recordFor({ id: 'row-0101', md5: 'g-new' }, '2026-10-02T00:00:00.000Z'),
          recordFor({ id: 'row-0102', md5: 'g-new' }, '2026-10-02T00:00:00.000Z'),
          // A third member of `g-grow`, one metric far past the 0.1 tolerance:
          // the group stops being admitted and its canonical row goes away.
          recordFor(
            { id: 'row-0103', md5: 'g-grow', overrides: { cjv: baseOf(POLICY, 'cjv') + 5 } },
            '2026-10-02T00:00:00.000Z',
          ),
        ],
      },
    ]);

    const result = await ingest({
      db,
      dumpsDir: dumps,
      snapshotDir: null,
      log: () => undefined,
    });

    expect(result.units[0]?.rowsAppended).toBe(3);
    expect(result.units[0]?.rowsReplaced).toBe(0);
    expect(result.recomputed).toEqual(['T2w']);
    expect(result.canonicalBefore['k3pp_t2w']).toBe(2);
    expect(result.canonicalAfter['k3pp_t2w']).toBe(2);

    // The counts coincide; the membership does not.
    expect(await canonicalGroups(db)).toEqual(['g-admit', 'g-new']);

    // The members table and the quarantine view followed along.
    const members = await db.withRead((connection) =>
      connection.all(
        `SELECT group_id AS g, id FROM ${quoteIdent(policyMembersTable(POLICY))} ORDER BY id`,
      ),
    );
    expect(members.map((row: Row) => String(row['id']))).toEqual([
      'row-0001',
      'row-0002',
      'row-0101',
      'row-0102',
    ]);
    const quarantined = await db.withRead((connection) =>
      connection.all(`SELECT id FROM v_k3pp_t2w_quarantined_raw ORDER BY id`),
    );
    expect(quarantined.map((row: Row) => String(row['id']))).toEqual([
      'row-0003',
      'row-0103',
    ]);

    // And the `_all` view is the canonical rows plus the quarantined raw ones.
    const all = await db.withRead((connection) =>
      connection.all(`SELECT count(*) AS n FROM v_t2w_k3pp_all`),
    );
    expect(Number(all[0]?.['n'])).toBe(4);

    // The log recorded the canonical counts either side of the recompute.
    const log = await db.withRead((connection) =>
      connection.all(`SELECT canonical_before AS b, canonical_after AS a FROM ingest_log`),
    );
    expect(Number(log[0]?.['b'])).toBe(2);
    expect(Number(log[0]?.['a'])).toBe(2);
  }, 120_000);

  it('grows the canonical table when the new rows form new groups only', async () => {
    const dumps = join(dir, 'dumps-grow');
    writeDumpDir(dumps, [
      {
        collection: 'T2w',
        records: [
          recordFor({ id: 'row-0201', md5: 'g-a' }, '2026-10-02T00:00:00.000Z'),
          recordFor({ id: 'row-0202', md5: 'g-b' }, '2026-10-02T00:00:00.000Z'),
        ],
      },
    ]);
    const result = await ingest({ db, dumpsDir: dumps, snapshotDir: null, log: () => undefined });
    expect(result.canonicalBefore['k3pp_t2w']).toBe(2);
    expect(result.canonicalAfter['k3pp_t2w']).toBe(4);
    expect(await canonicalGroups(db)).toEqual(['g-a', 'g-admit', 'g-b', 'g-grow']);
  }, 120_000);

  it('does not recompute for a collection with no policy', async () => {
    // `ratings` is not in this fixture at all, so a rating dump would fail. What
    // is asserted is the mapping: a modality-less collection recomputes nothing.
    const dumps = join(dir, 'dumps-none');
    writeDumpDir(dumps, [{ collection: 'T2w', records: [] }]);
    const result = await ingest({ db, dumpsDir: dumps, snapshotDir: null, log: () => undefined });
    expect(result.units[0]?.rowsAppended).toBe(0);
    expect(result.recomputed).toEqual([]);
    expect(result.dataVersion).toBe('base-version');
  }, 120_000);
});
