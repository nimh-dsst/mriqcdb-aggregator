/**
 * The template texts and the statement splitter.
 *
 * These assert the properties both runners depend on: every statement a procedure
 * asks for by name exists, the holes survived the move out of the `.sql` files,
 * and nothing in the text is a hole the runner would not fill.
 */

import { describe, expect, it } from 'vitest';
import {
  SQL_TEMPLATES,
  parseStatements,
  statementsOf,
  type TemplateName,
} from './templates.js';

/** The statements each procedure loads by name. */
const EXPECTED: Readonly<Record<TemplateName, readonly string[]>> = {
  density2d: ['stats', 'histogram', 'sample'],
  correlation: ['matrix'],
  distribution: ['stats', 'histogram', 'histogram_ranged'],
  grouped_summary: ['group_range', 'stats', 'histograms'],
  coverage: ['group_range', 'buckets'],
  binned_summary: ['stats', 'buckets'],
  sample: ['page'],
  export: ['rows'],
};

const NAMES = Object.keys(EXPECTED) as TemplateName[];

describe('parseStatements', () => {
  it('splits on the @statement header and trims each body', () => {
    const statements = parseStatements(
      ['-- a header comment', '-- @statement one', 'SELECT 1', '', '-- @statement two', 'SELECT 2'].join(
        '\n',
      ),
    );
    expect([...statements.keys()]).toEqual(['one', 'two']);
    expect(statements.get('one')).toBe('SELECT 1');
    expect(statements.get('two')).toBe('SELECT 2');
  });

  it('drops everything before the first header, so the file comment is not SQL', () => {
    expect(parseStatements('-- just a comment\n').size).toBe(0);
  });

  it('reads a CRLF file the same as an LF one', () => {
    const lf = parseStatements('-- @statement one\nSELECT 1');
    const crlf = parseStatements('-- @statement one\r\nSELECT 1');
    expect(crlf.get('one')).toBe(lf.get('one'));
  });
});

describe('statementsOf', () => {
  it.each(NAMES)('%s has exactly the statements the procedure asks for', (name) => {
    expect([...statementsOf(name).keys()].sort()).toEqual([...EXPECTED[name]].sort());
  });

  it('caches, so the same map comes back', () => {
    expect(statementsOf('distribution')).toBe(statementsOf('distribution'));
  });

  it.each(NAMES)('%s leaves no statement empty', (name) => {
    for (const [statement, sql] of statementsOf(name)) {
      expect([statement, sql.length > 0]).toEqual([statement, true]);
    }
  });

  it('keeps the {{table}} hole in every template, so no table name is ever literal', () => {
    for (const name of NAMES) {
      for (const [statement, sql] of statementsOf(name)) {
        expect([name, statement, sql.includes('{{table}}')]).toEqual([name, statement, true]);
      }
    }
  });

  it('uses only holes the runners fill', () => {
    const known = new Set([
      'table',
      'metric',
      'where',
      'group_expr',
      'group_numeric',
      'group_bins',
      'max_groups',
      'granularity',
      'bucket',
      'bucket_hi',
      'columns',
      'cursor',
      'x',
      'y',
      'sample_size',
      'seed',
      'metric_columns',
      'rank_columns',
      'aggregates',
    ]);
    for (const name of NAMES) {
      for (const hole of SQL_TEMPLATES[name].matchAll(/\{\{(\w+)\}\}/g)) {
        expect([name, hole[1], known.has(hole[1] as string)]).toEqual([name, hole[1], true]);
      }
    }
  });

  it('bins the requested range into bins, an underflow and an overflow', () => {
    const sql = statementsOf('distribution').get('histogram_ranged') as string;
    // The three arms the procedure reads back: below `lo`, above `hi`, and the
    // clamped bin index in between.
    expect(sql).toContain('THEN -1');
    expect(sql).toContain('WHEN x > CAST(? AS DOUBLE)');
    expect(sql).toContain('GROUP BY bin');
  });
});
