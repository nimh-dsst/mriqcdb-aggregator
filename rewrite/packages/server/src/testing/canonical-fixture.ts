/**
 * Hand-built groups for the canonicalization policy views.
 *
 * The shared `fixture.ts` observation files carry four metrics per modality, and
 * other tests recompute their quantiles in TypeScript from the row index, so the
 * 68 columns these policies need cannot be bolted onto them without rewriting
 * every expectation in the suite. This fixture instead builds a raw table with
 * exactly the policy's own columns, straight from a list of named groups, so each
 * admission decision is readable next to the row that causes it.
 *
 * Not part of the shipped package: `tsconfig.json` excludes this directory.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import {
  type CanonicalPolicy,
  type ScaleRow,
  createPolicyViews,
  createScaleTable,
} from '../db/canonical.js';
import type { DbConnection, Row } from '../db/instance.js';

/** One synthetic observation: the overrides applied on top of the group's base row. */
export type MemberSpec = Readonly<Record<string, number | null>>;

/** One hand-built group: a key, and one override map per member row. */
export interface GroupSpec {
  /** Becomes `provenance_md5sum`, so it is also the readable name of the group. */
  readonly md5: string;
  /** `provenance_version`; two members with different versions are different groups. */
  readonly version?: string;
  /** `provenance_settings_testing` for K3++, `provenance_settings_fd_thres` for K4+. */
  readonly setting?: boolean | number | null;
  /** `provenance_settings_hmc_fsl`, bold only. */
  readonly hmcFsl?: boolean | null;
  readonly members: readonly MemberSpec[];
}

/** A number as a SQL literal, with NULL and the non-finite doubles spelled out. */
function numberLiteral(value: number | null): string {
  if (value === null) return 'NULL';
  if (Number.isNaN(value)) return `CAST('NaN' AS DOUBLE)`;
  if (value === Number.POSITIVE_INFINITY) return `CAST('Infinity' AS DOUBLE)`;
  if (value === Number.NEGATIVE_INFINITY) return `CAST('-Infinity' AS DOUBLE)`;
  return `CAST(${value} AS DOUBLE)`;
}

function textLiteral(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;
}

function booleanLiteral(value: boolean | number | null | undefined): string {
  if (value === undefined || value === null) return 'NULL';
  if (typeof value === 'number') return `CAST(${value} AS DOUBLE)`;
  return value ? 'TRUE' : 'FALSE';
}

/**
 * The base value of one metric: distinct per metric so that a group where one
 * member's value is nudged has a diameter driven by that one metric alone, and so
 * that no metric is ever 0 (which would make a relative nudge a no-op).
 */
export function baseValue(metric: string, index: number): number {
  void metric;
  return 1 + index;
}

/**
 * The base value one metric gets in every member row, so a test can write an
 * override as `baseOf(policy, 'cjv') + 0.05` and not depend on the metric's
 * position in the list.
 */
export function baseOf(policy: CanonicalPolicy, metric: string): number {
  const index = [...policy.exact, ...policy.continuous].indexOf(metric);
  if (index < 0) throw new Error(`${policy.id} has no metric "${metric}"`);
  return baseValue(metric, index);
}

/** The settings column the policy's key reads, and the kind of value it holds. */
function settingColumn(policy: CanonicalPolicy): string {
  return policy.modality === 'bold'
    ? 'provenance_settings_fd_thres'
    : 'provenance_settings_testing';
}

/**
 * Create a raw table named `table` holding the groups, with one column per policy
 * metric plus the key columns and an `id`. Ids are assigned in group order and are
 * zero-padded, so the lowest id of a group is also its first member.
 */
export async function createRawTable(
  connection: DbConnection,
  policy: CanonicalPolicy,
  table: string,
  groups: readonly GroupSpec[],
): Promise<void> {
  const metrics = [...policy.exact, ...policy.continuous];
  const columns = [
    'id VARCHAR',
    'created_at TIMESTAMP',
    'provenance_md5sum VARCHAR',
    'provenance_version VARCHAR',
    `${settingColumn(policy)} ${policy.modality === 'bold' ? 'DOUBLE' : 'BOOLEAN'}`,
    ...(policy.modality === 'bold' ? ['provenance_settings_hmc_fsl BOOLEAN'] : []),
    ...metrics.map((metric) => `${metric} DOUBLE`),
  ];
  await connection.exec(`CREATE OR REPLACE TABLE ${table} (${columns.join(', ')})`);

  const rows: string[] = [];
  let serial = 0;
  for (const group of groups) {
    for (const member of group.members) {
      serial += 1;
      const values = [
        textLiteral(`row-${String(serial).padStart(4, '0')}`),
        `TIMESTAMP '2020-01-01 00:00:00' + INTERVAL (${serial}) DAY`,
        textLiteral(group.md5),
        textLiteral(group.version ?? '23.1.0'),
        booleanLiteral(group.setting ?? (policy.modality === 'bold' ? 0.2 : false)),
        ...(policy.modality === 'bold' ? [booleanLiteral(group.hmcFsl ?? null)] : []),
        ...metrics.map((metric, index) =>
          numberLiteral(
            Object.prototype.hasOwnProperty.call(member, metric)
              ? (member[metric] as number | null)
              : baseValue(metric, index),
          ),
        ),
      ];
      rows.push(`(${values.join(', ')})`);
    }
  }
  if (rows.length > 0) await connection.exec(`INSERT INTO ${table} VALUES ${rows.join(', ')}`);
}

/** A scale table of iqr = 1 for every metric, so a normalized range is the raw range. */
export function unitScales(policy: CanonicalPolicy): ScaleRow[] {
  return policy.continuous.map((metric) => ({
    metric,
    q25: 0,
    q75: 1,
    iqr: 1,
    fallback: false,
  }));
}

/** An in-memory database with one policy's views over hand-built groups. */
export interface CanonicalFixture {
  readonly connection: DbConnection;
  /** Every row of `v_<policy>_groups`, keyed by the group's md5. */
  groups(): Promise<Map<string, Row>>;
  /** Every row of `v_<policy>_canonical`, keyed by the group's md5. */
  canonical(): Promise<Map<string, Row>>;
  /** The ids `v_<policy>_quarantined_raw` emits, sorted. */
  quarantinedIds(): Promise<string[]>;
  /** The ids `v_<policy>_members` emits for one group's md5, sorted. */
  memberIds(md5: string): Promise<string[]>;
  close(): void;
}

/**
 * Build the fixture: a raw table, a scale table, and the policy's eight views over
 * them. `scales` defaults to iqr = 1 everywhere, which makes a normalized range the
 * raw range and so makes the tolerances readable in the group specs.
 */
export async function makeCanonicalFixture(
  policy: CanonicalPolicy,
  groups: readonly GroupSpec[],
  scales: readonly ScaleRow[] = unitScales(policy),
): Promise<CanonicalFixture> {
  const instance = await DuckDBInstance.create(':memory:');
  const raw = await instance.connect();
  const connection: DbConnection = {
    raw,
    async all(sql, params) {
      const reader = await raw.runAndReadAll(sql, [...(params ?? [])] as never[]);
      return reader.getRowObjectsJS() as Row[];
    },
    async exec(sql, params) {
      await raw.run(sql, [...(params ?? [])] as never[]);
    },
  };

  const table = `raw_${policy.id}`;
  await createRawTable(connection, policy, table, groups);
  await createScaleTable(connection, policy, scales);
  await createPolicyViews(connection, policy, { rawTable: table });

  const byMd5 = async (view: string): Promise<Map<string, Row>> => {
    const rows = await connection.all(`SELECT * FROM ${view}`);
    const keyed = new Map<string, Row>();
    for (const row of rows) {
      const key = String(row['group_id'] ?? row['provenance_md5sum']);
      keyed.set(key.split('|')[0] as string, row);
    }
    return keyed;
  };

  return {
    connection,
    groups: () => byMd5(`v_${policy.id}_groups`),
    canonical: () => byMd5(`v_${policy.id}_canonical`),
    async quarantinedIds() {
      const rows = await connection.all(
        `SELECT id FROM v_${policy.id}_quarantined_raw ORDER BY id`,
      );
      return rows.map((row) => String(row['id']));
    },
    async memberIds(md5) {
      const rows = await connection.all(
        `SELECT id FROM v_${policy.id}_members WHERE group_id LIKE ? ORDER BY id`,
        [`${md5}|%`],
      );
      return rows.map((row) => String(row['id']));
    },
    close() {
      raw.closeSync();
      instance.closeSync();
    },
  };
}
