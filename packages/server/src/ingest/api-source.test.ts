/**
 * The API source against a fake Eve: a list of records in insertion order that
 * ignores `where` and `sort`, exactly as the deployed API does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixture, type Fixture } from '../testing/fixture.js';
import { ApiSource, parseEveJson, toDumpRecord, type FetchLike } from './api-source.js';
import type { IngestCollection } from './flatten.js';
import { ingest } from './ingest.js';
import type { IngestState, IngestUnit } from './sources.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2030-01-01T00:00:00Z');

/** Record `n` of a collection, one day after the one before, as Eve serves it. */
function eveRecord(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const date = new Date(START + n * DAY).toUTCString();
  return { _id: `api-${String(n).padStart(4, '0')}`, _created: date, _updated: date, ...extra };
}

/** A fake Eve over `records`, counting requests; `failFirst` requests answer 503. */
function fakeEve(records: readonly Record<string, unknown>[], failFirst = 0) {
  const calls = { count: 0 };
  const fetch: FetchLike = async (url) => {
    calls.count += 1;
    if (calls.count <= failFirst) return { ok: false, status: 503, text: async () => '' };
    const query = new URL(url).searchParams;
    const size = Number(query.get('max_results'));
    const page = Number(query.get('page'));
    const items = records.slice((page - 1) * size, page * size);
    const last = Math.max(1, Math.ceil(records.length / size));
    const body = {
      _items: items,
      _meta: { total: records.length, page, max_results: size },
      _links: page < last ? { next: { href: `?page=${page + 1}` } } : {},
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

function stateAt(collection: IngestCollection, mark: Date | null): IngestState {
  return {
    knownHashes: new Set(),
    watermarks: new Map(mark === null ? [] : [[collection, mark]]),
  };
}

async function collect(source: ApiSource, state: IngestState): Promise<IngestUnit[]> {
  const units: IngestUnit[] = [];
  for await (const unit of source.units(state)) units.push(unit);
  return units;
}

describe('parseEveJson', () => {
  it('reads the bare NaN and Infinity Python writes as extended-JSON doubles', () => {
    const page = parseEveJson('{"_items":[{"a":NaN,"b":-Infinity,"c":[Infinity, 1]}],"_meta":{}}');
    expect(page._items[0]).toEqual({
      a: { $numberDouble: 'NaN' },
      b: { $numberDouble: '-Infinity' },
      c: [{ $numberDouble: 'Infinity' }, 1],
    });
  });
});

describe('toDumpRecord', () => {
  it('turns the RFC 1123 dates into $date and drops the links', () => {
    const record = toDumpRecord({
      _id: 'x',
      _created: 'Wed, 30 May 2018 15:04:31 GMT',
      _updated: 'Wed, 30 May 2018 15:04:32 GMT',
      _links: { self: {} },
      rating: '3',
    });
    expect(record).toEqual({
      _id: 'x',
      _created: { $date: '2018-05-30T15:04:31.000Z' },
      _updated: { $date: '2018-05-30T15:04:32.000Z' },
      rating: '3',
    });
  });
});

describe('ApiSource', () => {
  const records = Array.from({ length: 2500 }, (_, n) => eveRecord(n));

  it('reads from the watermark to the end, page by page, oldest first', async () => {
    const { fetch } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'], pageSize: 1000, overlap: 50 });
    const units = await collect(source, stateAt('T2w', new Date(START + 1800 * DAY)));

    const ids = units.flatMap((unit) => (unit.records ?? []).map((r) => (r as { _id: string })._id));
    expect(ids[0]).toBe('api-1800');
    expect(ids.at(-1)).toBe('api-2499');
    expect(ids).toHaveLength(700);
    expect(units.every((unit) => unit.collection === 'T2w' && unit.sha256 === null)).toBe(true);
  });

  it('finds a recent watermark with one probe and reads only the last page', async () => {
    const { fetch, calls } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'], pageSize: 100, overlap: 0 });
    const units = await collect(source, stateAt('T2w', new Date(START + 2450 * DAY)));
    expect(units.flatMap((unit) => unit.records ?? [])).toHaveLength(50);
    // The total, one probe, then the last page.
    expect(calls.count).toBe(3);
  });

  it('bisects a longer gap down to a page instead of reading every page', async () => {
    const { fetch, calls } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'], pageSize: 100, overlap: 0 });
    const units = await collect(source, stateAt('T2w', new Date(START + 333 * DAY)));
    expect(units.flatMap((unit) => unit.records ?? [])).toHaveLength(2500 - 333);
    // Reading from page 1 would be 25 pages; the search skips the first three.
    expect(calls.count).toBeLessThan(1 + 10 + 25);
  });

  it('yields nothing when nothing is newer than the watermark', async () => {
    const { fetch } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'], overlap: 10 });
    expect(await collect(source, stateAt('T2w', new Date(START + 9999 * DAY)))).toEqual([]);
  });

  it('resumes from the served table when no ingest has run yet', async () => {
    const { fetch } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'], overlap: 0 });
    const units = await collect(source, {
      ...stateAt('T2w', null),
      servedWatermarks: new Map([['T2w', new Date(START + 2490 * DAY)]]),
    });
    expect(units.flatMap((unit) => unit.records ?? [])).toHaveLength(10);
  });

  it('refuses to start from nothing: a full pull is a build, not an ingest', async () => {
    const { fetch } = fakeEve(records);
    const source = new ApiSource({ fetch, collections: ['T2w'] });
    await expect(collect(source, stateAt('T2w', null))).rejects.toThrow(/build the database from dumps/);
  });

  it('retries a failed request', async () => {
    const { fetch } = fakeEve(records, 2);
    const source = new ApiSource({ fetch, collections: ['T2w'], overlap: 0 });
    const units = await collect(source, stateAt('T2w', new Date(START + 2499 * DAY)));
    expect(units.flatMap((unit) => unit.records ?? [])).toHaveLength(1);
  });
});

describe('an ingest from the API', () => {
  let dir: string;
  let fixture: Fixture;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mriqc-api-')).replace(/\\/g, '/');
    fixture = await makeFixture(dir);
  }, 120_000);

  afterAll(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lands the new records in the raw table like a dump would', async () => {
    const fresh = [1, 2, 3].map((n) =>
      eveRecord(n, {
        provenance: { md5sum: `md5-api-${n}`, version: '24.0.0', settings: { fd_thres: 0.5 } },
        cjv: n === 2 ? Number.NaN : 1.5,
      }),
    );
    // JSON.stringify writes NaN as null, so the body is patched the way Python writes it.
    const { fetch: inner } = fakeEve(fresh);
    const fetch: FetchLike = async (url) => {
      const response = await inner(url);
      const text = (await response.text()).replace('"cjv":null', '"cjv":NaN');
      return { ...response, text: async () => text };
    };

    const result = await ingest({
      db: fixture.db,
      source: new ApiSource({ fetch, collections: ['T2w'], overlap: 0 }),
      snapshotDir: null,
      log: () => undefined,
    });

    expect(result.source).toBe('api');
    expect(result.units.reduce((n, unit) => n + unit.rowsAppended, 0)).toBe(3);
    const rows = await fixture.db.withRead((c) =>
      c.all(`SELECT id, updated_at, cjv FROM raw_t2w WHERE id LIKE 'api-%' ORDER BY id`),
    );
    expect(rows.map((row) => row['id'])).toEqual(['api-0001', 'api-0002', 'api-0003']);
    expect((rows[0]?.['updated_at'] as Date).toISOString()).toBe('2030-01-02T00:00:00.000Z');
    expect(rows[0]?.['cjv']).toBe(1.5);
    expect(Number.isNaN(rows[1]?.['cjv'] as number)).toBe(true);

    // The next pull re-reads the boundary record and adds nothing.
    const again = await ingest({
      db: fixture.db,
      source: new ApiSource({ fetch, collections: ['T2w'], overlap: 10 }),
      snapshotDir: null,
      log: () => undefined,
    });
    expect(again.units.reduce((n, unit) => n + unit.rowsAppended + unit.rowsReplaced, 0)).toBe(0);
    expect(again.dataVersion).toBe(result.dataVersion);
    const count = await fixture.db.withRead((c) =>
      c.all(`SELECT count(*) AS n FROM raw_t2w WHERE id LIKE 'api-%'`),
    );
    expect(Number(count[0]?.['n'])).toBe(3);
  }, 180_000);
});
