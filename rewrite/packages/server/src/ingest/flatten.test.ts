/**
 * The extended-JSON staging, as SQL text and against a real DuckDB.
 *
 * The flatten rules are the ones `C:/Users/licc/projects/mriqc/KEY.md` writes
 * down and `convert_T1w.sql` implements, so each is asserted here on the shape
 * that file quirk produced: a depth-1 JSON value that is sometimes a plain number
 * and sometimes an extended-JSON wrapper object.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColumnPlan } from '../db/build.js';
import type { DbConnection, Row } from '../db/instance.js';
import {
  COLLECTION_MODALITY,
  COLLECTION_TABLE,
  EXTENDED_JSON_KEYS,
  INGEST_COLLECTIONS,
  castToTypeSql,
  columnsScopeOf,
  isIngestCollection,
  jsonPathOf,
  planStaging,
  scalarTextSql,
} from './flatten.js';

describe('collection maps', () => {
  it('covers the four collections the dumps carry', () => {
    expect([...INGEST_COLLECTIONS]).toEqual(['T1w', 'T2w', 'bold', 'rating']);
    for (const collection of INGEST_COLLECTIONS) {
      expect(COLLECTION_TABLE[collection]).toBeTypeOf('string');
      expect(collection in COLLECTION_MODALITY).toBe(true);
    }
    expect(COLLECTION_MODALITY.rating).toBeNull();
    expect(COLLECTION_TABLE.rating).toBe('ratings');
  });

  it('scopes the `columns` lookup by modality, and by table name for the ratings', () => {
    expect(columnsScopeOf('T2w')).toBe('T2w');
    expect(columnsScopeOf('bold')).toBe('bold');
    expect(columnsScopeOf('rating')).toBe('ratings');
  });

  it('recognizes only the four names', () => {
    expect(isIngestCollection('T1w')).toBe(true);
    expect(isIngestCollection('dwi')).toBe(false);
    expect(isIngestCollection('')).toBe(false);
  });
});

describe('jsonPathOf', () => {
  it('quotes every segment of a dotted source name', () => {
    expect(jsonPathOf('cjv')).toBe('$."cjv"');
    expect(jsonPathOf('bids_meta.EchoTime')).toBe('$."bids_meta"."EchoTime"');
    expect(jsonPathOf('provenance.settings.fd_thres')).toBe(
      '$."provenance"."settings"."fd_thres"',
    );
    expect(jsonPathOf('_id')).toBe('$."_id"');
  });

  it('refuses a name DuckDB\'s path grammar cannot express', () => {
    expect(() => jsonPathOf('a."b')).toThrow(/JSON path/);
    expect(() => jsonPathOf('a.\\b')).toThrow(/JSON path/);
    expect(() => jsonPathOf('a..b')).toThrow(/JSON path/);
  });
});

describe('castToTypeSql', () => {
  it('leaves VARCHAR alone, so a JSON array keeps its text verbatim', () => {
    expect(castToTypeSql('"x"', 'VARCHAR')).toBe('"x"');
  });

  it('routes non-integral text to an integer through DOUBLE, as the Parquet load does', () => {
    const sql = castToTypeSql('"x"', 'BIGINT');
    expect(sql).toContain('regexp_full_match');
    expect(sql).toContain('TRY_CAST(TRY_CAST("x" AS DOUBLE) AS BIGINT)');
  });

  it('uses a plain TRY_CAST for everything else', () => {
    expect(castToTypeSql('"x"', 'DOUBLE')).toBe('TRY_CAST("x" AS DOUBLE)');
    expect(castToTypeSql('"x"', 'TIMESTAMP')).toBe('TRY_CAST("x" AS TIMESTAMP)');
    expect(castToTypeSql('"x"', 'BOOLEAN')).toBe('TRY_CAST("x" AS BOOLEAN)');
  });
});

describe('scalarTextSql', () => {
  it('coalesces every extended-JSON wrapper key', () => {
    const sql = scalarTextSql('"v"');
    for (const key of EXTENDED_JSON_KEYS) expect(sql).toContain(`$."${key}"`);
    expect(sql).toContain(`json_type("v") = 'OBJECT'`);
    expect(sql).toContain(`json_type("v") = 'NULL'`);
  });
});

describe('planStaging', () => {
  const targets: ColumnPlan[] = [
    { normalized: 'id', sourceName: '_id', duckType: 'VARCHAR' },
    { normalized: 'updated_at', sourceName: '_updated', duckType: 'TIMESTAMP' },
    { normalized: 'manufacturer', sourceName: 'bids_meta.Manufacturer', duckType: 'VARCHAR' },
    { normalized: 'manufacturer_raw', sourceName: 'bids_meta.Manufacturer', duckType: 'VARCHAR' },
    { normalized: 'summary_bg_n', sourceName: 'summary_bg_n', duckType: 'BIGINT' },
  ];

  it('stages each source name once and names the vendor column', () => {
    const plan = planStaging(targets);
    expect(plan.columns.map((column) => column.name)).toEqual([
      '_id',
      '_updated',
      'bids_meta.Manufacturer',
      'summary_bg_n',
    ]);
    expect(plan.manufacturerSource).toBe('bids_meta.Manufacturer');
  });

  it('carries the serving types through, so the projection over it is a pure rename', () => {
    const plan = planStaging(targets);
    expect(plan.columns.find((column) => column.name === 'summary_bg_n')?.type).toBe('BIGINT');
  });

  it('refuses two distinct columns claiming one source name', () => {
    expect(() =>
      planStaging([
        { normalized: 'a', sourceName: 'x', duckType: 'VARCHAR' },
        { normalized: 'b', sourceName: 'x', duckType: 'VARCHAR' },
      ]),
    ).toThrow(/claim the source name/);
  });

  it('refuses an empty target list', () => {
    expect(() => planStaging([])).toThrow(/nothing to stage/);
  });

  it('reports no vendor column when the table has none', () => {
    expect(planStaging([targets[0] as ColumnPlan]).manufacturerSource).toBeNull();
  });
});

/* ------------------------------------------------- against a real DuckDB */

/**
 * One record of each shape the dumps carry: wrapped scalars, a bare scalar, an
 * array, a nested object, an explicit JSON null and an absent key.
 */
const RECORDS = [
  {
    _id: { $oid: 'row-1' },
    _created: { $date: '2018-03-02T00:25:18.000Z' },
    _updated: { $date: '2018-03-02T00:25:18.000Z' },
    cjv: 0.5,
    efc: { $numberDouble: 'NaN' },
    fber: { $numberDouble: 'Infinity' },
    qi_1: { $numberDouble: '-Infinity' },
    size_x: 202,
    summary_bg_n: { $numberLong: '4608552' },
    bids_meta: {
      Manufacturer: 'SIEMENS  ',
      EchoTime: 0.03,
      ImageType: ['ORIGINAL', 'PRIMARY'],
      PartialFourier: true,
    },
    provenance: { md5sum: 'deadbeef', settings: { testing: false } },
  },
  {
    _id: { $oid: 'row-2' },
    cjv: null,
    size_x: 1000.5,
    bids_meta: { Manufacturer: null },
  },
];

const TARGETS: ColumnPlan[] = [
  { normalized: 'id', sourceName: '_id', duckType: 'VARCHAR' },
  { normalized: 'created_at', sourceName: '_created', duckType: 'TIMESTAMP' },
  { normalized: 'updated_at', sourceName: '_updated', duckType: 'TIMESTAMP' },
  { normalized: 'cjv', sourceName: 'cjv', duckType: 'DOUBLE' },
  { normalized: 'efc', sourceName: 'efc', duckType: 'DOUBLE' },
  { normalized: 'fber', sourceName: 'fber', duckType: 'DOUBLE' },
  { normalized: 'qi_1', sourceName: 'qi_1', duckType: 'DOUBLE' },
  { normalized: 'size_x', sourceName: 'size_x', duckType: 'BIGINT' },
  { normalized: 'summary_bg_n', sourceName: 'summary_bg_n', duckType: 'BIGINT' },
  { normalized: 'manufacturer', sourceName: 'bids_meta.Manufacturer', duckType: 'VARCHAR' },
  { normalized: 'echo_time', sourceName: 'bids_meta.EchoTime', duckType: 'DOUBLE' },
  { normalized: 'image_type', sourceName: 'bids_meta.ImageType', duckType: 'VARCHAR' },
  { normalized: 'partial_fourier', sourceName: 'bids_meta.PartialFourier', duckType: 'BOOLEAN' },
  { normalized: 'provenance_md5sum', sourceName: 'provenance.md5sum', duckType: 'VARCHAR' },
  {
    normalized: 'provenance_settings_testing',
    sourceName: 'provenance.settings.testing',
    duckType: 'BOOLEAN',
  },
];

describe('the staged relation', () => {
  let instance: DuckDBInstance;
  let connection: DbConnection;
  let rows: Row[];

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mriqc-flatten-')).replace(/\\/g, '/');
    const file = `${dir}/sample.json`;
    writeFileSync(file, JSON.stringify(RECORDS));

    instance = await DuckDBInstance.create(':memory:');
    const raw = await instance.connect();
    connection = {
      raw,
      async all(sql, params) {
        const reader = await raw.runAndReadAll(sql, [...(params ?? [])] as never[]);
        return reader.getRowObjectsJS() as Row[];
      },
      async exec(sql, params) {
        await raw.run(sql, [...(params ?? [])] as never[]);
      },
    };

    const plan = planStaging(TARGETS);
    await connection.exec(
      `CREATE VIEW j AS SELECT ${plan.jsonSelect} FROM read_json_objects('${file}', format = 'array')`,
    );
    await connection.exec(`CREATE VIEW t AS SELECT ${plan.textSelect} FROM j`);
    await connection.exec(`CREATE VIEW s AS SELECT ${plan.castSelect} FROM t`);
    rows = await connection.all(`SELECT * FROM s ORDER BY "_id"`);
  });

  afterAll(() => {
    connection.raw.closeSync();
    instance.closeSync();
  });

  it('unwraps the three MongoDB wrappers', () => {
    const row = rows[0] as Row;
    expect(row['_id']).toBe('row-1');
    expect(row['_created']).toBeInstanceOf(Date);
    expect((row['_created'] as Date).toISOString()).toBe('2018-03-02T00:25:18.000Z');
  });

  it('preserves NaN and both infinities as IEEE values, not NULL', () => {
    const row = rows[0] as Row;
    expect(Number.isNaN(row['efc'] as number)).toBe(true);
    expect(row['fber']).toBe(Number.POSITIVE_INFINITY);
    expect(row['qi_1']).toBe(Number.NEGATIVE_INFINITY);
    // Absent, NaN and Inf stay three distinct states.
    expect(row['cjv']).toBe(0.5);
    expect(rows[1]?.['cjv']).toBeNull();
  });

  it('keeps an array value as its JSON text, verbatim', () => {
    expect(rows[0]?.['bids_meta.ImageType']).toBe('["ORIGINAL","PRIMARY"]');
    expect(rows[1]?.['bids_meta.ImageType']).toBeNull();
  });

  it('reads nested objects by their dotted path', () => {
    expect(rows[0]?.['provenance.md5sum']).toBe('deadbeef');
    expect(rows[0]?.['provenance.settings.testing']).toBe(false);
    expect(rows[0]?.['bids_meta.PartialFourier']).toBe(true);
  });

  it('keeps the uploaded vendor string untouched at this stage', () => {
    expect(rows[0]?.['bids_meta.Manufacturer']).toBe('SIEMENS  ');
    expect(rows[1]?.['bids_meta.Manufacturer']).toBeNull();
  });

  it('takes an integer by its exact text and a decimal through DOUBLE', () => {
    expect(Number(rows[0]?.['summary_bg_n'])).toBe(4608552);
    expect(Number(rows[0]?.['size_x'])).toBe(202);
    // 1000.5 truncates, which is what `TRY_CAST(1000.5::DOUBLE AS BIGINT)` does
    // in the Parquet load; the direct `'1000.5'::BIGINT` route would round to 1001.
    expect(Number(rows[1]?.['size_x'])).toBe(1000);
  });

  it('leaves an absent key NULL', () => {
    expect(rows[1]?.['_updated']).toBeNull();
    expect(rows[1]?.['provenance.md5sum']).toBeNull();
  });
});
