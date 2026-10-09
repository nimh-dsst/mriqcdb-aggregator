import { asColumnId, statementsOf } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';
import type { StudyCoverageQuery, StudySampleQuery } from '../api/api';
import { compileStudyCoverage, compileStudySample, shapeStudyCoverage, shapeStudySample } from './study-records';

const scope = { source: 'study' as const, modality: 'bold' as const, view: 'raw' as const, filters: [] };
const columns = new Set(['bids_name', 'fd_mean', 'manufacturer', 'created_at']);
const coverage: StudyCoverageQuery = { ...scope, proc: 'coverage', group: asColumnId('manufacturer'), granularity: 'month' };
const sample: StudySampleQuery = { ...scope, proc: 'sample', columns: [asColumnId('bids_name'), asColumnId('fd_mean')], cursor: null };

describe('study record templates', () => {
  it('compiles byte-identical shared coverage text', () => {
    const bound = compileStudyCoverage(coverage, columns).buckets(null).statement;
    expect(bound.sql).toBe(statementsOf('coverage').get('buckets')!
      .replaceAll('{{table}}', '"study"').replaceAll('{{where}}', 'TRUE')
      .replaceAll('{{granularity}}', "'month'").replaceAll('{{group_expr}}', 'CAST("manufacturer" AS VARCHAR)'));
    expect(bound.params).toEqual([]);
  });

  it('adapts categories to count all records, including absent upload dates', () => {
    const bound = compileStudyCoverage({ ...coverage, countsOnly: true }, new Set(['bids_name', 'manufacturer'])).buckets(null).statement;
    expect(bound.template).toBe('coverage');
    expect(bound.sql).toContain("TIMESTAMP '2000-01-01' AS created_at");
    expect(bound.sql).toContain('count(*)');
    expect(bound.sql).not.toContain('{{');
  });

  it('does not invent an upload time for time-axis requests', () => {
    expect(() => compileStudyCoverage(coverage, new Set(['bids_name', 'manufacturer']))).toThrow('your file has no upload time');
  });

  it('allows ungrouped time counts without a categorical column', () => {
    expect(compileStudyCoverage({ ...coverage, group: asColumnId('created_at') }, new Set(['bids_name', 'created_at']))
      .buckets(null).statement.sql).toContain('NULL');
  });

  it('uses the shared sample page, preserving keyset parameters and hiding its synthetic timestamp', () => {
    const bound = compileStudySample({ ...sample, cursor: JSON.stringify(['123456', '8']) }, columns);
    const source = statementsOf('sample').get('page')!;
    const table = '(SELECT "bids_name", "fd_mean", "manufacturer", CAST(rowid AS VARCHAR) AS id, "created_at" AS __study_upload_time, coalesce("created_at", TIMESTAMP \'0001-01-01\') AS created_at FROM "study" WHERE TRUE)';
    expect(bound.sql).toBe(source.replaceAll('{{table}}', table).replaceAll('{{where}}', 'TRUE')
      .replaceAll('{{columns}}', '"bids_name", "fd_mean", "id", "created_at", __study_upload_time')
      .replaceAll('{{cursor}}', '(created_at, id) < (make_timestamp(CAST(? AS BIGINT)), CAST(? AS VARCHAR))'));
    expect(bound.params).toEqual(['123456', '8', 101]);
    expect(shapeStudySample([{ id: '8', fd_mean: 0.2, created_at: 0, __created_us: 0n, __study_upload_time: null }]))
      .toEqual({ rows: [{ id: '8', fd_mean: 0.2, created_at: null }], nextCursor: null });
  });

  it('pages without losing timestamp precision', () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i), __created_us: 1700000000000001n, __study_upload_time: 0 }));
    const result = shapeStudySample(rows);
    expect(result.rows).toHaveLength(100);
    expect(result.nextCursor).toBe('["1700000000000001","99"]');
  });

  it('shapes coverage timestamps and null categories without losing counts', () => {
    expect(shapeStudyCoverage([{ bucket: Date.UTC(2024, 0, 1), value: null, n: 300n }], value => value))
      .toEqual({ buckets: [{ start: '2024-01-01', group: null, n: 300 }] });
  });

  it('rejects absent columns, invalid cursors and invalid calendar units', () => {
    expect(() => compileStudySample({ ...sample, columns: [asColumnId('missing')] }, columns)).toThrow('no column');
    expect(() => compileStudySample({ ...sample, cursor: '["SQL", "id"]' }, columns)).toThrow('Invalid study cursor');
    expect(() => compileStudyCoverage({ ...coverage, granularity: 'invalid' as never }, columns)).toThrow('Invalid calendar');
  });
});
