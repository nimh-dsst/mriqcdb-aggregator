/**
 * The two pieces of `run.ts` whose arithmetic the templates depend on: numeric
 * group-bin labels, and the keyset cursor's resolution.
 *
 * The cursor half runs against a real table so the predicate is exercised as SQL,
 * not as a string.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FieldDef } from '@mriqc/shared';
import { asColumnId } from '@mriqc/shared';
import { Db } from '../db/instance.js';
import { TemplateError } from './run.js';
import {
  NUMERIC_GROUP_BINS,
  binLabel,
  binLabelDecimals,
  cursorFromRow,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  fill,
  groupExpr,
  loadTemplate,
  quoteIdent,
} from './run.js';

const numericField: FieldDef = {
  id: asColumnId('echo_time'),
  label: 'Echo time',
  kind: 'numeric',
  modalities: ['bold'],
  filterable: true,
  groupable: true,
  exportable: true,
};

describe('numeric group bins', () => {
  it('keeps every bin label distinct however narrow the range', () => {
    for (const width of [1, 0.1, 1e-4, 1e-5, 1e-7, 1e-10]) {
      const labels = Array.from({ length: NUMERIC_GROUP_BINS }, (_, i) => binLabel(0.03, width, i));
      expect(new Set(labels).size, `width ${width}`).toBe(NUMERIC_GROUP_BINS);
    }
  });

  it('still reads plainly at ordinary widths', () => {
    expect(binLabel(0.03, 0.0004, 0)).toBe('0.03–0.0304');
    expect(binLabel(0, 1, 3)).toBe('3–4');
    expect(binLabelDecimals(1)).toBe(4);
    expect(binLabelDecimals(0)).toBe(4);
  });

  it('groups by the bin index, never by the rendered label', () => {
    const group = groupExpr(numericField, { lo: 0.03, width: 1e-6 });
    // Grouping by rounded text was what merged adjacent bins; the key is an index.
    expect(group.expr).not.toContain('concat');
    expect(group.expr).toContain('floor');
    expect(group.params).toEqual([0.03, 1e-6]);
    expect(group.label(0)).toBe(binLabel(0.03, 1e-6, 0));
    expect(group.label(1)).toBe(binLabel(0.03, 1e-6, 1));
    expect(group.label(0)).not.toBe(group.label(1));
    expect(group.label(null)).toBeNull();
  });

  it('falls back to the raw value when there is nothing to bin', () => {
    expect(groupExpr(numericField, null).params).toEqual([]);
    expect(groupExpr(numericField, { lo: 1, width: 0 }).label('x')).toBe('x');
  });
});

describe('cursor', () => {
  it('round-trips a microsecond position', () => {
    const cursor = { createdAtUs: 1_577_836_800_000_123n, id: 'bold-0001' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('refuses anything it did not produce', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(TemplateError);
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(TemplateError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ us: 'soon', id: 'a' })).toString('base64url')),
    ).toThrow(TemplateError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ us: '1', id: 7 })).toString('base64url')),
    ).toThrow(TemplateError);
  });

  it('reads its position out of a page row', () => {
    expect(cursorFromRow({ __created_us: 123n, id: 'x' })).toEqual({
      createdAtUs: 123n,
      id: 'x',
    });
    expect(cursorFromRow({ __created_us: null, id: 'x' })).toBeNull();
  });
});

describe('keyset pagination at microsecond resolution', () => {
  let dir: string;
  let db: Db;

  /** Three rows inside one millisecond, which is what a JS `Date` cannot tell apart. */
  const ROWS = [
    ['2024-03-01 09:00:00.000001', 'row-a'],
    ['2024-03-01 09:00:00.000002', 'row-b'],
    ['2024-03-01 09:00:00.000003', 'row-c'],
  ] as const;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mriqc-cursor-'));
    db = new Db(join(dir, 'micro.duckdb'), 1);
    await db.withWriter(async (c) => {
      await c.exec('CREATE TABLE micro_rows (created_at TIMESTAMP, id VARCHAR)');
      for (const [created, id] of ROWS) {
        await c.exec('INSERT INTO micro_rows VALUES (CAST(? AS TIMESTAMP), ?)', [created, id]);
      }
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips no row when adjacent rows share a millisecond', async () => {
    const seen: string[] = [];
    let cursor: ReturnType<typeof cursorFromRow> = null;
    for (let page = 0; page < 5; page += 1) {
      const keyset = cursorPredicate(cursor);
      const rows = await db.withRead((c) =>
        c.all(
          fill(loadTemplate('sample', 'page'), {
            table: quoteIdent('micro_rows'),
            columns: '"created_at", "id"',
            where: 'TRUE',
            cursor: keyset.sql,
          }),
          [...keyset.params, 1],
        ),
      );
      if (rows.length === 0) break;
      const row = rows[0] as Record<string, unknown>;
      seen.push(String(row['id']));
      cursor = cursorFromRow(row);
      expect(cursor).not.toBeNull();
    }
    // Descending by `created_at`, so newest first -- and every row is visited, which
    // a millisecond-truncated cursor could not manage.
    expect(seen).toEqual(['row-c', 'row-b', 'row-a']);
  }, 60_000);
});
