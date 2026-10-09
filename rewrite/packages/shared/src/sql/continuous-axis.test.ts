import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asColumnId } from '../types.js';
import { binnedSummaryFragments, continuousAxisExpr } from './continuous-axis.js';
import { statementsOf, type TemplateName } from './templates.js';

let instance: DuckDBInstance;
let connection: DuckDBConnection;
const catalog = new Set(['created_at', 'metric_x', 'metric_y']);
function axis(id: string, kind: 'metric' | 'time'): string {
  if (!catalog.has(id)) throw new Error('unknown study column');
  return continuousAxisExpr(asColumnId(id), kind);
}
function sql(template: TemplateName, statement: string, holes: Record<string, string>): string {
  return statementsOf(template).get(statement)!.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (holes[key] === undefined) throw new Error(`unfilled ${key}`);
    return holes[key];
  });
}

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run(`CREATE TABLE study(created_at TIMESTAMP, metric_x DOUBLE, metric_y DOUBLE);
    INSERT INTO study VALUES
      ('2000-01-01',0,1), ('2000-01-02',1,3), ('2000-01-03',2,5), ('2000-01-04',3,7),
      ('infinity','Infinity',9), (NULL,NULL,11), ('2000-01-05',4,'NaN'), ('2000-01-06',5,NULL)`);
});
afterAll(() => { connection?.closeSync(); instance?.closeSync(); });

describe.each(['metric', 'time'] as const)('shared SQL with %s x', kind => {
  const holes = () => ({ table: 'study', x: axis(kind === 'time' ? 'created_at' : 'metric_x', kind),
    y: axis('metric_y', 'metric'), where: 'TRUE' });

  it('executes the density text unchanged on study columns, excluding nonfinite pairs', async () => {
    const common = { ...holes(), seed: '1', sample_size: '4' };
    const stats = (await connection.runAndReadAll(sql('density2d', 'stats', common))).getRowObjectsJS();
    expect(Number(stats[0]!['n'])).toBe(4);
    expect(Number(stats[0]!['x_min'])).toBe(0);
    expect(Number(stats[0]!['x_max'])).toBe(3);
    expect(stats[0]!['pearson']).toBeCloseTo(1, 12);
    expect(stats[0]!['spearman']).toBeCloseTo(1, 12);
    const grid = (await connection.runAndReadAll(sql('density2d', 'histogram', common),
      [0, 3, 2, 2, 0, 1.5, 1, 7, 2, 2, 1, 3])).getRowObjectsJS();
    expect(grid.map(r => [Number(r['bx']), Number(r['by']), Number(r['n'])]).sort()).toEqual([[0, 0, 2], [1, 1, 2]]);
    const sample = (await connection.runAndReadAll(sql('density2d', 'sample', common), [0, 3, 1, 7])).getRowObjectsJS();
    expect(sample.map(r => [Number(r['x']), Number(r['y'])])).toEqual([[0, 1], [1, 3], [2, 5], [3, 7]]);
  });

  it('executes the summary text with parameterized ranges and x-specific bucket expressions', async () => {
    const common = { ...holes(), ...binnedSummaryFragments(kind === 'time' ? 'day' : 2),
      group_expr: 'NULL::VARCHAR', group_numeric: 'FALSE', group_bins: '10', max_groups: '50' };
    const stats = (await connection.runAndReadAll(sql('binned_summary', 'stats', common))).getRowObjectsJS();
    expect(Number(stats[0]!['n'])).toBe(4);
    const buckets = (await connection.runAndReadAll(sql('binned_summary', 'buckets', common), [0, 3, 2])).getRowObjectsJS();
    expect(buckets.map(r => Number(r['n']))).toEqual(kind === 'time' ? [1, 1, 1, 1] : [2, 2]);
    expect(buckets.map(r => Number(r['bucket']))).toEqual(kind === 'time' ? [0, 1, 2, 3] : [0, 1]);
    if (kind === 'time') expect(buckets.map(r => Number(r['bucket_hi']))).toEqual([1, 2, 3, 4]);
    else {
      const expected = [[1.1, 1.5, 2, 2.5, 2.9], [5.1, 5.5, 6, 6.5, 6.9]];
      buckets.forEach((row, i) => (row['qs'] as number[]).forEach((q, j) =>
        expect(q).toBeCloseTo(expected[i]![j]!, 12)));
    }
  });
});

it('only constructs expressions from locally validated identifiers and bounded bin units', () => {
  expect(() => axis('metric_x); DROP TABLE study; --', 'metric')).toThrow('unknown study column');
  expect(() => binnedSummaryFragments('quarter' as never)).toThrow('invalid granularity');
  expect(() => binnedSummaryFragments(0)).toThrow('invalid bin count');
  expect(continuousAxisExpr(asColumnId('a"b'), 'metric')).toBe('CAST("a""b" AS DOUBLE)');
});
