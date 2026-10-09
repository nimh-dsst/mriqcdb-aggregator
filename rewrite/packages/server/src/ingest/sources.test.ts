/**
 * The two record sources, and the manifest contract they share with
 * `tools/mriqc-dump/`.
 *
 * `MongoSource` is exercised against the real driver only when
 * `MRIQC_MONGO_URI` is set, and the test says so when it is not: nothing on this
 * machine can reach a MongoDB, so what is asserted here is the parts that do not
 * need one -- the selection logic, the manifest, and that a credential never
 * reaches a log line.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DumpDirSource,
  MANIFEST_FILE,
  MongoSource,
  RecordsSource,
  orderedEntries,
  parseManifest,
  sha256File,
  type IngestState,
  type IngestUnit,
} from './sources.js';

const EMPTY: IngestState = { knownHashes: new Set(), watermarks: new Map() };

/** A 64-character hex digest, so the manifest validator is satisfied. */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-sources-')).replace(/\\/g, '/');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write one dump file and return its manifest entry. */
function writeFile(collection: string, records: unknown[], stamp: string): Record<string, unknown> {
  const file = `mriqc_api.${collection}.${stamp}.json`;
  const text = JSON.stringify(records);
  writeFileSync(join(dir, file), text);
  return {
    file,
    collection,
    records: records.length,
    maxUpdated: '2026-10-05T00:00:00.000Z',
    sha256: digestOf(text),
  };
}

function writeManifest(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ version: 1, files: entries }));
}

async function collect(source: {
  units(state: IngestState): AsyncIterable<IngestUnit>;
}): Promise<IngestUnit[]> {
  const units: IngestUnit[] = [];
  for await (const unit of source.units(EMPTY)) units.push(unit);
  return units;
}

describe('parseManifest', () => {
  it('reads a well-formed manifest', () => {
    const entry = writeFile('T2w', [{ a: 1 }], '20261008T000000');
    const manifest = parseManifest(JSON.stringify({ version: 1, files: [entry] }));
    expect(manifest.version).toBe(1);
    expect(manifest.files[0]?.collection).toBe('T2w');
    expect(manifest.files[0]?.records).toBe(1);
    expect(manifest.files[0]?.since).toBeNull();
  });

  it('refuses malformed JSON, a missing files array and a bad collection', () => {
    expect(() => parseManifest('{')).toThrow(/not valid JSON/);
    expect(() => parseManifest('{}')).toThrow(/"files" array/);
    expect(() =>
      parseManifest(JSON.stringify({ files: [{ file: 'x.json', collection: 'dwi', sha256: digestOf('x') }] })),
    ).toThrow(/collection must be one of/);
  });

  it('refuses a digest that is not 64 hex characters', () => {
    expect(() =>
      parseManifest(JSON.stringify({ files: [{ file: 'x.json', collection: 'T2w', sha256: 'abc' }] })),
    ).toThrow(/64-character hex/);
  });

  it('refuses a file name that is a path, so nothing reaches outside the directory', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          files: [{ file: '../secrets.json', collection: 'T2w', sha256: digestOf('x') }],
        }),
      ),
    ).toThrow(/bare file name/);
  });
});

describe('orderedEntries', () => {
  it('orders by _updated then by name, so a later re-send wins the upsert', () => {
    const files = [
      { file: 'b', collection: 'T2w' as const, records: 1, maxUpdated: '2026-10-05T00:00:00Z', sha256: 'x' },
      { file: 'a', collection: 'T2w' as const, records: 1, maxUpdated: '2026-10-01T00:00:00Z', sha256: 'y' },
      { file: 'c', collection: 'T2w' as const, records: 1, maxUpdated: '2026-10-05T00:00:00Z', sha256: 'z' },
    ];
    expect(orderedEntries({ version: 1, files }).map((entry) => entry.file)).toEqual(['a', 'b', 'c']);
  });
});

describe('DumpDirSource', () => {
  it('yields one unit per manifest file, newest last', async () => {
    const first = writeFile('T2w', [{ a: 1 }], '20261001T000000');
    const second = { ...writeFile('bold', [{ a: 2 }], '20261008T000000'), maxUpdated: '2026-10-08T00:00:00.000Z' };
    writeManifest([second, first]);
    const units = await collect(new DumpDirSource(dir));
    expect(units.map((unit) => unit.collection)).toEqual(['T2w', 'bold']);
    expect(units[0]?.path).toContain('mriqc_api.T2w.20261001T000000.json');
    expect(units[0]?.sha256).toBe(first['sha256']);
    expect(units[0]?.recordCount).toBe(1);
  });

  it('skips a file whose sha256 is already in ingest_log', async () => {
    const entry = writeFile('T2w', [{ a: 1 }], '20261001T000000');
    writeManifest([entry]);
    const logged: string[] = [];
    const source = new DumpDirSource(dir, { log: (message) => logged.push(message) });
    const units: IngestUnit[] = [];
    for await (const unit of source.units({
      knownHashes: new Set([String(entry['sha256'])]),
      watermarks: new Map(),
    })) {
      units.push(unit);
    }
    expect(units).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/already in ingest_log/);
  });

  it('refuses a manifest whose digest no longer matches the file', async () => {
    const entry = writeFile('T2w', [{ a: 1 }], '20261001T000000');
    writeFileSync(join(dir, String(entry['file'])), JSON.stringify([{ a: 2 }]));
    writeManifest([entry]);
    await expect(collect(new DumpDirSource(dir))).rejects.toThrow(/parted company/);
  });

  it('trusts the manifest when verification is off', async () => {
    const entry = writeFile('T2w', [{ a: 1 }], '20261001T000000');
    writeFileSync(join(dir, String(entry['file'])), JSON.stringify([{ a: 2 }]));
    writeManifest([entry]);
    const units = await collect(new DumpDirSource(dir, { verify: false }));
    expect(units).toHaveLength(1);
  });

  it('says how to seed a directory that has no manifest', async () => {
    await expect(collect(new DumpDirSource(dir))).rejects.toThrow(/--adopt/);
  });

  it('refuses a manifest naming a file that is not there', async () => {
    writeManifest([{ file: 'mriqc_api.T2w.20261001T000000.json', collection: 'T2w', records: 1, sha256: digestOf('x') }]);
    await expect(collect(new DumpDirSource(dir))).rejects.toThrow(/not in/);
  });

  it('describes itself without a credential', () => {
    expect(new DumpDirSource(dir).describe()).toContain(dir);
    expect(new DumpDirSource(dir).kind).toBe('dumps');
  });
});

describe('sha256File', () => {
  it('matches a digest taken in memory', async () => {
    const path = join(dir, 'x.json');
    writeFileSync(path, 'hello');
    expect(await sha256File(path)).toBe(digestOf('hello'));
  });
});

describe('RecordsSource', () => {
  it('yields one unit per page, with no file and no digest', async () => {
    const source = new RecordsSource([
      { collection: 'T2w', records: [{ a: 1 }, { a: 2 }] },
      { collection: 'rating', records: [{ b: 1 }] },
    ]);
    const units = await collect(source);
    expect(units.map((unit) => unit.collection)).toEqual(['T2w', 'rating']);
    expect(units[0]?.records).toHaveLength(2);
    expect(units[0]?.sha256).toBeNull();
    expect(units[0]?.file).toBeNull();
    await source.close();
  });
});

describe('MongoSource', () => {
  it('refuses an empty connection string', () => {
    expect(() => new MongoSource({ uri: '  ' })).toThrow(/MRIQC_MONGO_URI/);
  });

  it('never puts the URI in the line it logs', () => {
    const source = new MongoSource({
      uri: 'mongodb://mriqc:secret@mongo.example.org:27017/mriqc_api',
      database: 'mriqc_api',
    });
    expect(source.describe()).not.toContain('secret');
    expect(source.describe()).toContain('mriqc_api');
    expect(source.kind).toBe('mongo');
  });

  const uri = process.env['MRIQC_MONGO_URI'];
  it.skipIf(uri === undefined || uri.trim() === '')(
    'pulls from a real MongoDB when MRIQC_MONGO_URI is set',
    async () => {
      const source = new MongoSource({ uri: uri as string, batchSize: 10 });
      try {
        let seen = 0;
        for await (const unit of source.units(EMPTY)) {
          expect(unit.records).toBeDefined();
          expect(unit.sha256).toBeNull();
          seen += unit.records?.length ?? 0;
          if (seen > 0) break;
        }
        expect(seen).toBeGreaterThan(0);
      } finally {
        await source.close();
      }
    },
    60_000,
  );
});
