/**
 * The canonicalization policy views, against hand-built groups, plus the frozen
 * scale artifacts.
 *
 * What is asserted: that admission turns on each of its four reasons separately
 * (non-finite, varying exact field, diameter over tolerance, and nothing wrong),
 * that the diameter is the normalized range of the worst metric, that the
 * representative is the L1 medoid rather than just the lowest id, that membership
 * and quarantine partition the corpus, and that the committed scale CSVs load and
 * still name exactly the metrics the SQL normalizes.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOLD_CONTINUOUS_METRICS,
  BOLD_EXACT_METRICS,
  CANONICAL_POLICIES,
  STRUCT_CONTINUOUS_METRICS,
  STRUCT_EXACT_FIELDS,
  parseScaleCsv,
  policyAllView,
  policyAllViewId,
  policyById,
  policyCanonTable,
  policyGroupsTable,
  policyMembersTable,
  policySqlPath,
  policyStatements,
  policyView,
  readScales,
} from './canonical.js';
import { materializePolicy, type PolicyCounts } from './build.js';
import { tableFor } from './views.js';
import {
  type GroupSpec,
  baseOf,
  makeCanonicalFixture,
  unitScales,
} from '../testing/canonical-fixture.js';

const T1W = policyById('k3pp_t1w');
const BOLD = policyById('k4plus_bold');

/** `v_*_groups` reports booleans and counts; read them without repeating the casts. */
const flag = (row: Record<string, unknown> | undefined, column: string): boolean =>
  Boolean(row?.[column]);
const count = (row: Record<string, unknown> | undefined, column: string): number =>
  Number(row?.[column]);

describe('metric lists', () => {
  it('are the sizes the two specs state', () => {
    expect(BOLD_EXACT_METRICS).toHaveLength(5);
    expect(BOLD_CONTINUOUS_METRICS).toHaveLength(31);
    expect(STRUCT_EXACT_FIELDS).toHaveLength(6);
    expect(STRUCT_CONTINUOUS_METRICS).toHaveLength(62);
  });

  it('have no duplicates', () => {
    for (const list of [BOLD_CONTINUOUS_METRICS, STRUCT_CONTINUOUS_METRICS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('the committed policy SQL', () => {
  it.each(CANONICAL_POLICIES.map((p) => p.id))(
    '%s normalizes exactly the metrics the TypeScript list names',
    (id) => {
      const policy = policyById(id);
      const sql = readFileSync(policySqlPath(policy), 'utf8');
      const normalized = [...sql.matchAll(/max\(iqr\) FILTER \(WHERE metric = '([^']+)'\)/g)].map(
        (match) => match[1],
      );
      expect(normalized).toEqual([...policy.continuous]);
      const ranged = [...sql.matchAll(/max\(n_(\w+)\) - min\(n_\1\) AS rng_\1/g)].map((m) => m[1]);
      expect(ranged).toEqual([...policy.continuous]);
      // Anchored on the `x_` prefix, which keeps it off the aggregate
      // `exact_constant` conjunction further down the same statement.
      const exact = [...sql.matchAll(/x_(\w+)\).* AS (\w+)_constant,/g)]
        .filter((match) => match[1] === match[2])
        .map((match) => match[1]);
      expect(exact).toEqual([...policy.exact]);
    },
  );

  it.each(CANONICAL_POLICIES.map((p) => p.id))('%s fills both table holes and no others', (id) => {
    const policy = policyById(id);
    const statements = policyStatements(policy, { rawTable: 'r', scaleTable: 's' });
    expect(statements.map((s) => s.name)).toEqual([
      'normalized', 'groups', 'members', 'vectors', 'vector_cost', 'representative',
      'canonical', 'quarantined_raw',
    ]);
    for (const { sql } of statements) expect(sql).not.toMatch(/\{\{/);
    expect(statements[0]?.sql).toContain('FROM "r" r');
    expect(statements[0]?.sql).toContain('FROM "s"');
  });

  it('refuses a template with an unfilled hole', () => {
    // `policyStatements` fills exactly two holes; a third would be a programming
    // error rather than something a caller can supply.
    const sql = readFileSync(policySqlPath(T1W), 'utf8');
    expect(sql).not.toMatch(/\{\{(?!raw_table|scale_table)/);
  });
});

describe('K3++ admission, diameter and representative', () => {
  const cjv = baseOf(T1W, 'cjv');
  const qi2 = baseOf(T1W, 'qi_2');
  const sizeX = baseOf(T1W, 'size_x');

  /**
   * Seven groups, one per behaviour. With unit scales a normalized range is the raw
   * range, so the K3++ tolerance of 0.1 is readable straight off these numbers.
   */
  const GROUPS: readonly GroupSpec[] = [
    // Three identical rows: admitted, one distinct vector, diameter exactly 0.
    { md5: 'exact-dup', members: [{}, {}, {}] },
    // Two rows 0.05 apart on one metric: inside the tolerance.
    { md5: 'fuzzy-in', members: [{}, { cjv: cjv + 0.05 }] },
    // Two rows 0.2 apart: outside it.
    { md5: 'fuzzy-out', members: [{}, { cjv: cjv + 0.2 }] },
    // A NaN anywhere in the 62-vector quarantines the group whatever its diameter.
    { md5: 'has-nan', members: [{}, { qi_2: Number.NaN }] },
    // So does a NULL.
    { md5: 'has-null', members: [{}, { qi_2: null }] },
    // Identical metrics but a varying exact field: diameter 0 and still quarantined.
    { md5: 'size-varies', members: [{}, { size_x: sizeX + 1 }] },
    // Three distinct vectors at 0, 0.02 and 0.09. L1 costs over the distinct
    // vectors are 0.11, 0.09 and 0.16, so the medoid is the middle one -- the
    // second member, not the lowest id.
    {
      md5: 'medoid-mid',
      members: [{}, { cjv: cjv + 0.02 }, { cjv: cjv + 0.09 }],
    },
  ];

  it('admits, quarantines and measures each group for its own reason', async () => {
    const fixture = await makeCanonicalFixture(T1W, GROUPS);
    try {
      const groups = await fixture.groups();
      expect([...groups.keys()].sort()).toEqual([
        'exact-dup', 'fuzzy-in', 'fuzzy-out', 'has-nan', 'has-null', 'medoid-mid', 'size-varies',
      ]);

      expect(flag(groups.get('exact-dup'), 'admitted')).toBe(true);
      expect(count(groups.get('exact-dup'), 'group_rows')).toBe(3);
      expect(count(groups.get('exact-dup'), 'distinct_vectors')).toBe(1);
      expect(count(groups.get('exact-dup'), 'diameter')).toBe(0);

      expect(flag(groups.get('fuzzy-in'), 'admitted')).toBe(true);
      expect(count(groups.get('fuzzy-in'), 'distinct_vectors')).toBe(2);
      expect(count(groups.get('fuzzy-in'), 'diameter')).toBeCloseTo(0.05, 12);

      expect(flag(groups.get('fuzzy-out'), 'admitted')).toBe(false);
      expect(count(groups.get('fuzzy-out'), 'diameter')).toBeCloseTo(0.2, 12);
      expect(flag(groups.get('fuzzy-out'), 'has_nonfinite')).toBe(false);
      expect(flag(groups.get('fuzzy-out'), 'exact_constant')).toBe(true);

      for (const md5 of ['has-nan', 'has-null']) {
        expect(flag(groups.get(md5), 'admitted')).toBe(false);
        expect(flag(groups.get(md5), 'has_nonfinite')).toBe(true);
        expect(count(groups.get(md5), 'nonfinite_rows')).toBe(1);
      }

      expect(flag(groups.get('size-varies'), 'admitted')).toBe(false);
      expect(flag(groups.get('size-varies'), 'exact_constant')).toBe(false);
      expect(flag(groups.get('size-varies'), 'size_x_constant')).toBe(false);
      expect(flag(groups.get('size-varies'), 'size_y_constant')).toBe(true);
      expect(count(groups.get('size-varies'), 'diameter')).toBe(0);

      expect(flag(groups.get('medoid-mid'), 'admitted')).toBe(true);
      expect(count(groups.get('medoid-mid'), 'distinct_vectors')).toBe(3);
      expect(count(groups.get('medoid-mid'), 'diameter')).toBeCloseTo(0.09, 12);
    } finally {
      fixture.close();
    }
  });

  it('emits the medoid row, the tie-break row, and the policy columns', async () => {
    const fixture = await makeCanonicalFixture(T1W, GROUPS);
    try {
      const canonical = await fixture.canonical();
      expect([...canonical.keys()].sort()).toEqual([
        'exact-dup', 'fuzzy-in', 'medoid-mid',
      ]);

      // One distinct vector: the lowest of the three ids carrying it.
      expect(canonical.get('exact-dup')?.['id']).toBe('row-0001');
      // Two equidistant vectors: the tie-break takes the lowest id.
      expect(canonical.get('fuzzy-in')?.['id']).toBe('row-0004');
      // Three vectors, and the medoid is the second member (row-0015), not the
      // lowest id of the group (row-0014).
      expect(canonical.get('medoid-mid')?.['id']).toBe('row-0015');

      const row = canonical.get('medoid-mid');
      expect(row?.['canonical_policy']).toBe('K3++-T1w');
      expect(row?.['canonical_group_rows']).toBe(3n);
      expect(row?.['canonical_distinct_vectors']).toBe(3n);
      expect(Number(row?.['canonical_diameter'])).toBeCloseTo(0.09, 12);
      expect(row?.['canonical_selection']).toBe('observed_normalized_l1_medoid');
      // The raw columns come through unchanged, under their normalized names.
      expect(Number(row?.['cjv'])).toBeCloseTo(cjv + 0.02, 12);
      expect(row?.['canonical_hmc_mode']).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('partitions the corpus into members and quarantined raw rows', async () => {
    const fixture = await makeCanonicalFixture(T1W, GROUPS);
    try {
      expect(await fixture.memberIds('exact-dup')).toEqual(['row-0001', 'row-0002', 'row-0003']);
      expect(await fixture.memberIds('fuzzy-in')).toEqual(['row-0004', 'row-0005']);
      expect(await fixture.memberIds('fuzzy-out')).toEqual([]);
      // Every row of every quarantined group, and nothing else: 2 + 2 + 2 + 2.
      expect(await fixture.quarantinedIds()).toEqual([
        'row-0006', 'row-0007', 'row-0008', 'row-0009',
        'row-0010', 'row-0011', 'row-0012', 'row-0013',
      ]);
    } finally {
      fixture.close();
    }
  });

  it('takes the diameter from the worst metric, not the first', async () => {
    const fixture = await makeCanonicalFixture(T1W, [
      { md5: 'two-metrics', members: [{}, { cjv: cjv + 0.01, qi_2: qi2 + 0.07 }] },
    ]);
    try {
      const group = (await fixture.groups()).get('two-metrics');
      expect(count(group, 'diameter')).toBeCloseTo(0.07, 12);
      expect(Number(group?.['rng_cjv'])).toBeCloseTo(0.01, 12);
      expect(Number(group?.['rng_qi_2'])).toBeCloseTo(0.07, 12);
      expect(flag(group, 'admitted')).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('splits a key on the version and on the testing flag', async () => {
    const fixture = await makeCanonicalFixture(T1W, [
      { md5: 'same-md5', version: '22.0.6', members: [{}] },
      { md5: 'same-md5', version: '23.1.0', members: [{}] },
      { md5: 'same-md5', version: '23.1.0', setting: true, members: [{}] },
    ]);
    try {
      const rows = await fixture.connection.all(
        'SELECT group_id, group_rows FROM v_k3pp_t1w_groups ORDER BY group_id',
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => Number(r['group_rows']))).toEqual([1, 1, 1]);
      expect(rows.map((r) => String(r['group_id']))).toEqual([
        'same-md5|22.0.6|false', 'same-md5|23.1.0|false', 'same-md5|23.1.0|true',
      ]);
    } finally {
      fixture.close();
    }
  });
});

describe('K4+ admission and hmc_mode', () => {
  const snr = baseOf(BOLD, 'snr');
  const fdNum = baseOf(BOLD, 'fd_num');

  it('separates the exact metrics from the 1e-6 tolerance', async () => {
    const fixture = await makeCanonicalFixture(BOLD, [
      { md5: 'exact-dup', members: [{}, {}] },
      // Inside 1e-6 on a continuous metric.
      { md5: 'fuzzy-in', members: [{}, { snr: snr + 5e-7 }] },
      // Outside it.
      { md5: 'fuzzy-out', members: [{}, { snr: snr + 2e-6 }] },
      // An exact metric with two distinct values: quarantined at diameter 0.
      { md5: 'exact-differs', members: [{}, { fd_num: fdNum + 1 }] },
      // A non-finite value in an exact metric is still a non-finite vector.
      { md5: 'exact-nan', members: [{}, { fd_num: Number.NaN }] },
      { md5: 'cont-inf', members: [{}, { snr: Number.POSITIVE_INFINITY }] },
    ]);
    try {
      const groups = await fixture.groups();
      expect(flag(groups.get('exact-dup'), 'admitted')).toBe(true);
      expect(flag(groups.get('fuzzy-in'), 'admitted')).toBe(true);
      expect(count(groups.get('fuzzy-in'), 'diameter')).toBeCloseTo(5e-7, 14);
      expect(flag(groups.get('fuzzy-out'), 'admitted')).toBe(false);

      expect(flag(groups.get('exact-differs'), 'admitted')).toBe(false);
      expect(flag(groups.get('exact-differs'), 'fd_num_constant')).toBe(false);
      expect(flag(groups.get('exact-differs'), 'dummy_trs_constant')).toBe(true);
      expect(count(groups.get('exact-differs'), 'diameter')).toBe(0);

      for (const md5 of ['exact-nan', 'cont-inf']) {
        expect(flag(groups.get(md5), 'admitted')).toBe(false);
        expect(count(groups.get(md5), 'nonfinite_rows')).toBe(1);
      }
    } finally {
      fixture.close();
    }
  });

  it('derives hmc_mode from the version and hmc_fsl, and keys on it', async () => {
    const fixture = await makeCanonicalFixture(BOLD, [
      { md5: 'old-fsl', version: '0.15.1', hmcFsl: true, members: [{}] },
      { md5: 'old-afni', version: '0.15.1', hmcFsl: false, members: [{}] },
      { md5: 'old-null', version: '0.15.1', hmcFsl: null, members: [{}] },
      { md5: 'new-null', version: '0.16.0', hmcFsl: null, members: [{}] },
      { md5: 'new-set', version: '23.1.0', hmcFsl: true, members: [{}] },
      { md5: 'unparseable', version: 'release-candidate', hmcFsl: true, members: [{}] },
      // One md5, one version, one fd_thres, two hmc_fsl values: two groups, so the
      // derived mode is part of the key and not just a reported column.
      { md5: 'split', version: '0.15.1', hmcFsl: true, members: [{}] },
      { md5: 'split', version: '0.15.1', hmcFsl: false, members: [{}] },
    ]);
    try {
      const rows = await fixture.connection.all(
        `SELECT group_id, hmc_mode, group_rows FROM v_k4plus_bold_groups ORDER BY group_id`,
      );
      const mode = new Map(rows.map((r) => [String(r['group_id']).split('|')[0], r['hmc_mode']]));
      expect(mode.get('old-fsl')).toBe('fsl');
      expect(mode.get('old-afni')).toBe('afni');
      // Below 0.16 with no flag is covered by neither rule: unknown.
      expect(mode.get('old-null')).toBe('unknown');
      expect(mode.get('new-null')).toBe('afni');
      // At or above 0.16 with the flag set is likewise uncovered.
      expect(mode.get('new-set')).toBe('unknown');
      expect(mode.get('unparseable')).toBe('unknown');

      const split = rows.filter((r) => String(r['group_id']).startsWith('split|'));
      expect(split).toHaveLength(2);
      expect(split.map((r) => r['hmc_mode']).sort()).toEqual(['afni', 'fsl']);
      expect(split.map((r) => Number(r['group_rows']))).toEqual([1, 1]);
    } finally {
      fixture.close();
    }
  });

  it('carries canonical_hmc_mode on the canonical row', async () => {
    const fixture = await makeCanonicalFixture(BOLD, [
      { md5: 'old-fsl', version: '0.15.1', hmcFsl: true, members: [{}, {}] },
    ]);
    try {
      const row = (await fixture.canonical()).get('old-fsl');
      expect(row?.['canonical_hmc_mode']).toBe('fsl');
      expect(row?.['canonical_policy']).toBe('K4+');
      expect(row?.['id']).toBe('row-0001');
    } finally {
      fixture.close();
    }
  });
});

describe('the frozen scale tables', () => {
  it.each(CANONICAL_POLICIES.map((p) => p.id))('%s loads and covers every metric', (id) => {
    const policy = policyById(id);
    const scales = readScales(policy);
    expect(scales).toHaveLength(policy.continuous.length);
    expect(scales.map((row) => row.metric)).toEqual([...policy.continuous]);
    for (const row of scales) {
      expect(row.iqr).toBeGreaterThan(0);
      // The recipe computes iqr as q75 - q25, so the file has to agree with itself.
      expect(row.iqr).toBeCloseTo(row.q75 - row.q25, 12);
    }
  });

  it('flags the one zero-IQR fallback, T2w summary_bg_p05, and nothing else', () => {
    const fallbacks = Object.fromEntries(
      CANONICAL_POLICIES.map((policy) => [
        policy.id,
        readScales(policy).filter((row) => row.fallback).map((row) => row.metric),
      ]),
    );
    expect(fallbacks).toEqual({
      k4plus_bold: [],
      k3pp_t1w: [],
      k3pp_t2w: ['summary_bg_p05'],
    });
    const fallback = readScales(policyById('k3pp_t2w')).find((row) => row.fallback);
    expect(fallback?.iqr).toBeCloseTo(15.036358946561814, 9);
  });

  it('rejects a CSV whose header or row shape is wrong', () => {
    expect(() => parseScaleCsv('metric,iqr\ncjv,1\n')).toThrow(/header must start/);
    expect(() => parseScaleCsv('metric,q25,q75,iqr\ncjv,1,2\n')).toThrow(/3 cells/);
    expect(() => parseScaleCsv('metric,q25,q75,iqr\ncjv,1,2,nope\n')).toThrow(/non-finite/);
  });

  it('reads the fallback column only when the header declares it', () => {
    expect(parseScaleCsv('metric,q25,q75,iqr\ncjv,1,2,1\n')[0]?.fallback).toBe(false);
    expect(parseScaleCsv('metric,q25,q75,iqr,fallback\ncjv,1,2,1,true\n')[0]?.fallback).toBe(true);
    expect(parseScaleCsv('metric,q25,q75,iqr,fallback\ncjv,1,2,1,false\n')[0]?.fallback).toBe(false);
  });

  it('refuses to build a scale table with a non-positive iqr', async () => {
    const degenerate = STRUCT_CONTINUOUS_METRICS.map((metric) => ({
      metric, q25: 0, q75: 0, iqr: metric === 'cjv' ? 0 : 1, fallback: false,
    }));
    await expect(
      makeCanonicalFixture(T1W, [{ md5: 'any', members: [{}] }], degenerate),
    ).rejects.toThrow(/non-positive iqr for cjv/);
  });
});

describe('materializing a policy', () => {
  const cjv = baseOf(T1W, 'cjv');

  /**
   * Three admitted groups over eight rows, four quarantined groups over eight
   * more: enough that every count the build records is a different number.
   */
  const GROUPS: readonly GroupSpec[] = [
    { md5: 'admit-dup', members: [{}, {}, {}] },
    { md5: 'admit-near', members: [{}, { cjv: cjv + 0.05 }] },
    { md5: 'admit-three', members: [{}, { cjv: cjv + 0.02 }, { cjv: cjv + 0.09 }] },
    { md5: 'reject-wide', members: [{}, { cjv: cjv + 0.2 }] },
    { md5: 'reject-nan', members: [{}, { cjv: Number.NaN }] },
    { md5: 'reject-null', members: [{}, { cjv: null }] },
    { md5: 'reject-size', members: [{}, { size_x: baseOf(T1W, 'size_x') + 1 }] },
  ];

  /** The materialized relations, over the fixture's own raw table. */
  async function materialize(): Promise<{
    fixture: Awaited<ReturnType<typeof makeCanonicalFixture>>;
    counts: PolicyCounts;
  }> {
    const fixture = await makeCanonicalFixture(T1W, GROUPS);
    const counts = await materializePolicy(fixture.connection, T1W, {
      rawTable: `raw_${T1W.id}`,
      scales: unitScales(T1W),
    });
    return { fixture, counts };
  }

  it('counts what the policy admitted and what it refused', async () => {
    const { fixture, counts } = await materialize();
    try {
      expect(counts).toEqual({
        admittedGroups: 3,
        admittedRows: 8,
        quarantinedGroups: 4,
        quarantinedRows: 8,
      });
      const rows = async (relation: string): Promise<number> => {
        const result = await fixture.connection.all(`SELECT count(*) AS n FROM ${relation}`);
        return Number(result[0]?.['n']);
      };
      // One canonical row per admitted group; one membership row per collapsed
      // raw row; the quarantined view is the rest of the corpus.
      expect(await rows(policyCanonTable(T1W))).toBe(3);
      expect(await rows(policyMembersTable(T1W))).toBe(8);
      expect(await rows(policyGroupsTable(T1W))).toBe(7);
      expect(await rows(policyView(T1W, 'quarantined_raw'))).toBe(8);
    } finally {
      fixture.close();
    }
  });

  it('keeps the quarantined view a view over raw, not a table', async () => {
    const { fixture } = await materialize();
    try {
      const kinds = await fixture.connection.all(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_name IN (?, ?, ?)
         ORDER BY table_name`,
        [policyView(T1W, 'quarantined_raw'), policyAllView(T1W), policyMembersTable(T1W)],
      );
      expect(kinds.map((row) => [String(row['table_name']), String(row['table_type'])])).toEqual([
        [policyMembersTable(T1W), 'BASE TABLE'],
        [policyView(T1W, 'quarantined_raw'), 'VIEW'],
        [policyAllView(T1W), 'VIEW'],
      ]);
    } finally {
      fixture.close();
    }
  });

  it('unions canonical and quarantined rows, with the canonical-only fields NULL', async () => {
    const { fixture } = await materialize();
    try {
      const all = await fixture.connection.all(
        `SELECT count(*) AS n,
                count(*) FILTER (WHERE canonical_policy IS NULL) AS no_policy,
                count(*) FILTER (WHERE canonical_diameter IS NULL) AS no_diameter,
                count(*) FILTER (WHERE canonical_group_rows IS NULL) AS no_group_rows,
                count(DISTINCT id) AS ids
         FROM ${policyAllView(T1W)}`,
      );
      // Three canonical rows plus eight quarantined ones, every row a distinct
      // raw row, and the canonical-only columns null on exactly the quarantined
      // half.
      expect(Number(all[0]?.['n'])).toBe(11);
      expect(Number(all[0]?.['ids'])).toBe(11);
      expect(Number(all[0]?.['no_policy'])).toBe(8);
      expect(Number(all[0]?.['no_diameter'])).toBe(8);
      expect(Number(all[0]?.['no_group_rows'])).toBe(8);

      // Same columns on both halves, in the same order.
      const columns = await fixture.connection.all(`DESCRIBE ${policyAllView(T1W)}`);
      const canon = await fixture.connection.all(`DESCRIBE ${policyCanonTable(T1W)}`);
      expect(columns.map((r) => String(r['column_name']))).toEqual(
        canon.map((r) => String(r['column_name'])),
      );
    } finally {
      fixture.close();
    }
  });

  it('names the relations the view map serves', () => {
    for (const policy of CANONICAL_POLICIES) {
      expect(tableFor(policy.modality, policy.view)).toBe(policyCanonTable(policy));
      expect(tableFor(policy.modality, policyAllViewId(policy))).toBe(policyAllView(policy));
    }
  });
});
