/**
 * The Arrow export, read back with `apache-arrow` itself.
 *
 * The handler is driven over a real HTTP socket, so what the test parses is the
 * bytes on the wire, not an in-process object.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { tableFromIPC } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RAW_ROWS, isInfRow, isNaNRow, isNullRow, makeFixture, manufacturerOf, type Fixture } from '../testing/fixture.js';
import {
  ARROW_STREAM_MIME,
  ExportRequestError,
  handleExport,
  parseExportRequest,
  streamExport,
} from './arrow.js';

let dir: string;
let fixture: Fixture;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-export-'));
  fixture = await makeFixture(dir);
  server = createServer((req, res) => {
    handleExport(fixture.db, req, res).catch((error: unknown) => {
      // A failure after the first byte can only be reported by tearing the
      // connection down; anything else would be lost behind a 200.
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/export`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseExportRequest', () => {
  it('reads modality, view, columns and filters out of the query string', () => {
    const request = parseExportRequest(
      new URLSearchParams({
        modality: 'bold',
        view: 'raw',
        columns: 'id,fd_mean',
        filters: '[{"field":"manufacturer","op":"in","values":["GE"]}]',
      }),
    );
    expect(request).toMatchObject({ modality: 'bold', view: 'raw', columns: ['id', 'fd_mean'] });
    expect(request.filters).toHaveLength(1);
  });

  it.each([
    ['an unknown modality', { modality: 'DWI', view: 'raw', columns: 'id' }],
    ['an unknown view', { modality: 'bold', view: 'nope', columns: 'id' }],
    ['no columns', { modality: 'bold', view: 'raw', columns: '' }],
    ['malformed filters', { modality: 'bold', view: 'raw', columns: 'id', filters: '{' }],
  ])('refuses %s', (_name, params) => {
    expect(() => parseExportRequest(new URLSearchParams(params))).toThrow();
  });

  // Export is "validated by the same zod schemas" as the procedures. Checking only
  // `Array.isArray` let these through to a TypeError deep in the filter compiler,
  // and so to a 500 for what is plainly a bad request.
  it.each([
    ['a null entry', { filters: '[null]' }],
    ['a filter that is not an object', { filters: '["manufacturer"]' }],
    ['an unknown operator', { filters: '[{"field":"manufacturer","op":"like","values":["GE"]}]' }],
    ['a missing field', { filters: '[{"op":"isNull"}]' }],
    ['a wrong-typed value', { filters: '[{"field":"manufacturer","op":"in","values":[{"a":1}]}]' }],
    ['values that are not a list', { filters: '[{"field":"manufacturer","op":"in","values":"GE"}]' }],
    ['filters that are not a list', { filters: '{"field":"manufacturer"}' }],
    ['a selection with no range', { selection: '{"metric":"fd_mean"}' }],
    ['a selection range of one', { selection: '{"metric":"fd_mean","range":[1]}' }],
    ['a selection range of strings', { selection: '{"metric":"fd_mean","range":["1","2"]}' }],
  ])('refuses %s', (_name, extra) => {
    expect(() =>
      parseExportRequest(
        new URLSearchParams({ modality: 'bold', view: 'raw', columns: 'id', ...extra }),
      ),
    ).toThrow(ExportRequestError);
  });
});

describe('GET /export', () => {
  it.each(['selection', 'selections'] as const)('accepts %s and streams only the intersected metric ranges', async key => {
    const first = { metric: 'fd_mean', range: [10, 40] };
    const second = { metric: 'efc', range: [2, 6] };
    const params = new URLSearchParams({ modality: 'bold', view: 'raw', columns: 'id,fd_mean,efc',
      [key]: JSON.stringify(key === 'selection' ? first : [first, second]) });
    const parsed = parseExportRequest(params);
    expect(parsed.selections).toHaveLength(key === 'selection' ? 1 : 2);
    const response = await fetch(`${base}?${params}`);
    expect(response.status).toBe(200);
    const table = tableFromIPC(new Uint8Array(await response.arrayBuffer()));
    const expected = Array.from({ length: 61 }, (_, i) => i + 20).filter(i =>
      !isNaNRow(i) && !isInfRow(i) && !isNullRow(i) &&
      (key === 'selection' || (i % 13 >= 2 && i % 13 <= 5)));
    expect(table.numRows).toBe(expected.length);
    expect(table.getChild('fd_mean')?.toArray().every((x: number) => x >= 10 && x <= 40)).toBe(true);
  });

  it.each([
    { selections: '[{"metric":"fd_mean","range":[0,1]},{"metric":"fd_mean","range":[2,3]}]' },
    { selections: JSON.stringify(['fd_mean', 'efc', 'fber', 'fwhm_x', 'fwhm_y'].map(metric => ({ metric, range: [0, 1] }))) },
    { selections: '[]', selection: '{"metric":"fd_mean","range":[0,1]}' },
    { selections: '[{"metric":"efc","range":[2,1]}]' },
    { selections: '[{"metric":"cjv","range":[0,1]}]' },
    { selections: 'null' },
  ])('rejects invalid selections over HTTP: %j', async extra => {
    const params = new URLSearchParams({ modality: 'bold', view: 'raw', columns: 'id', ...extra });
    expect((await fetch(`${base}?${params}`)).status).toBe(400);
  });

  it('streams an Arrow table with the requested columns and the filtered rows', async () => {
    const filters = JSON.stringify([{ field: 'manufacturer', op: 'in', values: ['Siemens'] }]);
    const response = await fetch(
      `${base}?modality=bold&view=raw&columns=${encodeURIComponent('id,fd_mean,manufacturer')}` +
        `&filters=${encodeURIComponent(filters)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(ARROW_STREAM_MIME);

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const table = tableFromIPC(bytes);
    // The keyset columns are always present, ahead of what was asked for.
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'created_at',
      'id',
      'fd_mean',
      'manufacturer',
    ]);

    const expected = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(
      (i) => manufacturerOf(i) === 'Siemens',
    ).length;
    expect(table.numRows).toBe(expected);
    expect([...new Set(table.getChild('manufacturer')?.toArray() ?? [])]).toEqual(['Siemens']);
  });

  it('exports every row when nothing is filtered, across DuckDB chunk boundaries', async () => {
    const response = await fetch(`${base}?modality=bold&view=raw&columns=id,manufacturer`);
    const table = tableFromIPC(new Uint8Array(await response.arrayBuffer()));
    // More than one 2048-row DuckDB chunk, and the nulls in `manufacturer` are not
    // spread evenly across them: both are what broke the stream before.
    expect(RAW_ROWS).toBeGreaterThan(2048);
    expect(table.batches.length).toBeGreaterThan(1);
    expect(table.numRows).toBe(RAW_ROWS);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['created_at', 'id', 'manufacturer']);
    expect(table.getChild('manufacturer')?.nullCount).toBeGreaterThan(0);
  });

  it('answers 400 for a column that is not exportable', async () => {
    const response = await fetch(`${base}?modality=bold&view=raw&columns=provenance_settings_fd_thres`);
    expect(response.status).toBe(400);
  });

  it.each([
    ['a null filter entry', 'filters=' + encodeURIComponent('[null]')],
    [
      'a wrong-typed filter value',
      'filters=' + encodeURIComponent('[{"field":"manufacturer","op":"in","values":[{"a":1}]}]'),
    ],
    ['a selection with no range', 'selection=' + encodeURIComponent('{"metric":"fd_mean"}')],
  ])('answers 400, not 500, for %s', async (_name, query) => {
    const response = await fetch(`${base}?modality=bold&view=raw&columns=id&${query}`);
    expect(response.status).toBe(400);
  });
});

describe('export backpressure', () => {
  /** A `ServerResponse` stand-in that accepts one chunk and then never drains. */
  function stalledResponse(): PassThrough & ServerResponse {
    const stream = new PassThrough({ highWaterMark: 1 });
    Object.assign(stream, { setHeader: () => undefined, headersSent: false });
    return stream as unknown as PassThrough & ServerResponse;
  }

  it('stops writing when the client stops reading, and gives up when it disconnects', async () => {
    const request = parseExportRequest(
      new URLSearchParams({
        modality: 'bold',
        view: 'raw',
        columns: 'id,manufacturer,institution_name,protocol_name,task_id',
      }),
    );
    const res = stalledResponse();

    let settled = false;
    const streaming = streamExport(fixture.db, request, res).then(() => {
      settled = true;
    });

    // Nobody reads, so the writer must be parked on drain rather than racing
    // DuckDB to the end of the table and holding the result in memory.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const buffered = res.writableLength;
    expect(settled).toBe(false);
    expect(buffered).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(res.writableLength).toBe(buffered);

    // The client goes away: the fetch loop must notice and release the connection.
    const abandonedAt = Date.now();
    res.destroy();
    await streaming;
    expect(Date.now() - abandonedAt).toBeLessThan(1000);

    // And the pooled connection is usable again, which it would not be if the loop
    // were still fetching rows nobody will read.
    const rows = await fixture.db.withRead((c) => c.all('SELECT 1 AS one'), 10_000);
    expect(Number(rows[0]?.['one'])).toBe(1);
  }, 30_000);

  it('stops the stream when a real client aborts, and keeps serving', async () => {
    const controller = new AbortController();
    const started = fetch(`${base}?modality=bold&view=raw&columns=id,manufacturer`, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(started).rejects.toThrow();

    const after = await fetch(`${base}?modality=bold&view=raw&columns=id&filters=` +
      encodeURIComponent('[{"field":"manufacturer","op":"in","values":["GE"]}]'));
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 30_000);
});
