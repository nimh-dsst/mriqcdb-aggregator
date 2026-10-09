/**
 * The dump tool, tested with a fake `mongoexport`.
 *
 * MongoDB and the real `mongoexport` are deliberately not required: what this
 * tool contributes is the command construction, the file naming, the manifest
 * watermark and the record/sha256 summary, and all four are exercised here
 * against `test/fake-mongoexport.mjs` and a handful of records. Whether the real
 * `mongoexport` honours the flags is the one thing no test on this machine can
 * answer.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  DUMP_FILE_PATTERN,
  MANIFEST_FILE,
  adopt,
  commandLine,
  describeDump,
  dump,
  dumpFileName,
  jsonArrayRecords,
  mongoexportArgs,
  readManifest,
  redactUri,
  sha256File,
  stampOf,
  summarizeDump,
  updatedOf,
  watermarkOf,
  withEntry,
  writeManifest,
} from '../src/dump.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(HERE, 'fake-mongoexport.mjs');
const URI = 'mongodb://mriqc:secret@mongo.example.org:27017/mriqc_api';

/** One T2w-shaped record in the extended-JSON shape the real dumps carry. */
function record(id, updated, extra = {}) {
  return {
    _id: { $oid: id },
    _created: { $date: '2018-03-02T00:25:18.000Z' },
    _updated: { $date: updated },
    provenance: { md5sum: `md5-${id}`, version: '0.10.3' },
    bids_meta: { modality: 'T2w', Manufacturer: 'SIEMENS  ' },
    cjv: 0.5,
    ...extra,
  };
}

const DATA = {
  T1w: [record('a1'.padStart(24, '0'), '2026-10-01T00:00:00.000Z')],
  T2w: [
    record('b1'.padStart(24, '0'), '2026-10-01T00:00:00.000Z'),
    record('b2'.padStart(24, '0'), '2026-10-05T12:00:00.000Z'),
  ],
  bold: [],
  rating: [
    {
      _id: { $oid: 'c1'.padStart(24, '0') },
      _updated: { $date: '2026-10-02T00:00:00.000Z' },
      md5sum: 'md5-b1',
      rating: '3',
    },
  ],
};

let dir;
let dataPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-dump-')).replace(/\\/g, '/');
  dataPath = join(dir, 'data.json');
  writeFileSync(dataPath, JSON.stringify(DATA));
  process.env.FAKE_MONGOEXPORT_DATA = dataPath;
});

afterEach(() => {
  delete process.env.FAKE_MONGOEXPORT_DATA;
  delete process.env.FAKE_MONGOEXPORT_FAIL;
  rmSync(dir, { recursive: true, force: true });
});

/** Run the tool with the fake exporter, out of a subdirectory of the temp dir. */
async function runDump(options = {}) {
  return dump({
    uri: URI,
    out: join(dir, 'dumps'),
    mongoexport: process.execPath,
    // The fake exporter is a Node script, so `node <script> …` is the program.
    runner: async (program, args) => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(program, [FAKE, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`exit ${String(result.status)}: ${result.stderr}`);
    },
    log: () => undefined,
    ...options,
  });
}

describe('file naming', () => {
  it('stamps in UTC as YYYYMMDDTHHMMSS', () => {
    expect(stampOf(new Date('2026-10-08T03:04:05.678Z'))).toBe('20261008T030405');
  });

  it('names a dump file as the doc specifies', () => {
    const name = dumpFileName('T2w', new Date('2026-10-08T03:04:05Z'));
    expect(name).toBe('mriqc_api.T2w.20261008T030405.json');
    expect(DUMP_FILE_PATTERN.exec(name)?.[1]).toBe('T2w');
  });

  it('recognizes the existing undated full dumps too', () => {
    expect(DUMP_FILE_PATTERN.exec('mriqc_api.T1w.json')?.[1]).toBe('T1w');
    expect(DUMP_FILE_PATTERN.exec('mriqc_api.dwi.json')).toBeNull();
    expect(DUMP_FILE_PATTERN.exec('mriqc_api.T1w.parquet')).toBeNull();
  });
});

describe('mongoexportArgs', () => {
  it('builds the no-filter form when there is no watermark', () => {
    expect(mongoexportArgs({ uri: URI, collection: 'bold', out: '/tmp/x.json' })).toEqual([
      '--uri',
      URI,
      '--collection',
      'bold',
      '--jsonArray',
      '--out',
      '/tmp/x.json',
    ]);
  });

  it('adds a greater-than extended-JSON date filter when given one', () => {
    const args = mongoexportArgs({
      uri: URI,
      collection: 'T2w',
      out: '/tmp/x.json',
      since: '2026-10-05T12:00:00.000Z',
      db: 'mriqc_api',
    });
    expect(args.slice(0, 4)).toEqual(['--uri', URI, '--db', 'mriqc_api']);
    expect(args).toContain('--query');
    expect(JSON.parse(args[args.indexOf('--query') + 1])).toEqual({
      _updated: { $gt: { $date: '2026-10-05T12:00:00.000Z' } },
    });
  });

  it('redacts the credential from the printed command line', () => {
    const line = commandLine('mongoexport', mongoexportArgs({ uri: URI, collection: 'T2w', out: 'o' }));
    expect(line).not.toContain('secret');
    expect(line).toContain('//***:***@');
    expect(redactUri('mongodb://host/db')).toBe('mongodb://host/db');
  });
});

describe('--dry-run', () => {
  it('prints one command per collection and writes nothing', async () => {
    const printed = [];
    const { commands, entries } = await runDump({ dryRun: true, log: (m) => printed.push(m) });
    expect(commands).toHaveLength(COLLECTIONS.length);
    expect(entries).toHaveLength(0);
    expect(printed.every((line) => line.startsWith('[dry run] '))).toBe(true);
    expect(existsSync(join(dir, 'dumps', MANIFEST_FILE))).toBe(false);
    for (const command of commands) expect(command).not.toContain('secret');
  });
});

describe('a real run against the fake exporter', () => {
  it('writes dated files, counts records, hashes them and updates the manifest', async () => {
    const now = new Date('2026-10-08T03:04:05Z');
    const { entries } = await runDump({ now });
    const out = join(dir, 'dumps');

    // bold is empty in the fixture, so its file is removed and not recorded.
    expect(entries.map((entry) => entry.collection)).toEqual(['T1w', 'T2w', 'rating']);
    expect(existsSync(join(out, 'mriqc_api.bold.20261008T030405.json'))).toBe(false);

    const manifest = readManifest(out);
    expect(manifest.version).toBe(1);
    expect(manifest.files).toHaveLength(3);
    const t2w = manifest.files.find((entry) => entry.collection === 'T2w');
    expect(t2w.file).toBe('mriqc_api.T2w.20261008T030405.json');
    expect(t2w.records).toBe(2);
    expect(t2w.maxUpdated).toBe('2026-10-05T12:00:00.000Z');
    expect(t2w.since).toBeNull();
    expect(t2w.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t2w.bytes).toBeGreaterThan(0);
    expect(t2w.sha256).toBe(await sha256File(join(out, t2w.file)));
  });

  it('resumes from the manifest watermark, so the second run exports only what is new', async () => {
    const out = join(dir, 'dumps');
    await runDump({ now: new Date('2026-10-08T03:00:00Z') });

    // A third T2w record, newer than the first run's watermark.
    const grown = structuredClone(DATA);
    grown.T2w.push(record('b3'.padStart(24, '0'), '2026-10-07T06:00:00.000Z'));
    writeFileSync(dataPath, JSON.stringify(grown));

    const { commands, entries } = await runDump({ now: new Date('2026-10-09T03:00:00Z') });
    const t2wCommand = commands.find((line) => line.includes('--collection T2w'));
    expect(t2wCommand).toContain('2026-10-05T12:00:00.000Z');

    const t2w = entries.find((entry) => entry.collection === 'T2w');
    expect(t2w.records).toBe(1);
    expect(t2w.since).toBe('2026-10-05T12:00:00.000Z');
    expect(t2w.maxUpdated).toBe('2026-10-07T06:00:00.000Z');
    expect(watermarkOf(readManifest(out), 'T2w')).toBe('2026-10-07T06:00:00.000Z');

    // Nothing new at all the third time: no file, no manifest entry.
    const third = await runDump({ now: new Date('2026-10-10T03:00:00Z') });
    expect(third.entries).toHaveLength(0);
    expect(readManifest(out).files).toHaveLength(4);
  });

  it('overrides every watermark when --since is given', async () => {
    await runDump({ now: new Date('2026-10-08T03:00:00Z') });
    const { commands } = await runDump({
      now: new Date('2026-10-09T03:00:00Z'),
      since: '2020-01-01T00:00:00.000Z',
      dryRun: true,
    });
    for (const line of commands) expect(line).toContain('2020-01-01T00:00:00.000Z');
  });

  it('reports a failing exporter rather than recording a manifest entry', async () => {
    process.env.FAKE_MONGOEXPORT_FAIL = '1';
    await expect(runDump()).rejects.toThrow(/exit 3/);
    expect(existsSync(join(dir, 'dumps', MANIFEST_FILE))).toBe(false);
  });
});

describe('manifest', () => {
  it('replaces an entry for the same file rather than duplicating it', () => {
    const first = withEntry({ version: 1, files: [] }, { file: 'a.json', records: 1 });
    const second = withEntry(first, { file: 'a.json', records: 2 });
    expect(second.files).toEqual([{ file: 'a.json', records: 2 }]);
  });

  it('takes the highest _updated across a collection\'s files as the watermark', () => {
    const manifest = {
      version: 1,
      files: [
        { file: 'a', collection: 'T2w', maxUpdated: '2026-01-01T00:00:00.000Z' },
        { file: 'b', collection: 'T2w', maxUpdated: '2026-03-01T00:00:00.000Z' },
        { file: 'c', collection: 'T2w', maxUpdated: null },
        { file: 'd', collection: 'bold', maxUpdated: '2027-01-01T00:00:00.000Z' },
      ],
    };
    expect(watermarkOf(manifest, 'T2w')).toBe('2026-03-01T00:00:00.000Z');
    expect(watermarkOf(manifest, 'T1w')).toBeNull();
  });

  it('writes through a rename, leaving no temporary behind', () => {
    writeManifest(dir, { version: 1, files: [{ file: 'x' }] });
    expect(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')).files).toEqual([{ file: 'x' }]);
    expect(existsSync(`${join(dir, MANIFEST_FILE)}.writing-${process.pid}`)).toBe(false);
  });

  it('refuses a manifest that is not an object with a files array', () => {
    writeFileSync(join(dir, MANIFEST_FILE), '[]');
    expect(() => readManifest(dir)).toThrow(/files/);
  });
});

describe('reading a dump back', () => {
  it('streams the top-level elements of a pretty-printed array', async () => {
    const path = join(dir, 'pretty.json');
    writeFileSync(path, JSON.stringify([{ a: 1, b: { c: [1, 2] } }, { a: 2 }], null, 2));
    const texts = [];
    for await (const text of jsonArrayRecords(path)) texts.push(text);
    expect(texts).toHaveLength(2);
    expect(JSON.parse(texts[0])).toEqual({ a: 1, b: { c: [1, 2] } });
  });

  it('is not confused by braces and brackets inside strings', async () => {
    const path = join(dir, 'strings.json');
    writeFileSync(path, JSON.stringify([{ s: '}{][ \\" }' }, { s: 'plain' }]));
    const texts = [];
    for await (const text of jsonArrayRecords(path)) texts.push(text);
    expect(texts.map((text) => JSON.parse(text).s)).toEqual(['}{][ \\" }', 'plain']);
  });

  it('counts records and finds the highest _updated of an empty array', async () => {
    const path = join(dir, 'empty.json');
    writeFileSync(path, '[]');
    expect(await summarizeDump(path)).toEqual({ records: 0, maxUpdated: null });
  });

  it('reads _updated in every extended-JSON spelling', () => {
    expect(updatedOf({ _updated: { $date: '2026-01-01T00:00:00.000Z' } })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(updatedOf({ _updated: '2026-01-01T00:00:00.000Z' })).toBe('2026-01-01T00:00:00.000Z');
    expect(updatedOf({ _updated: { $date: { $numberLong: '1767225600000' } } })).toBe(
      new Date(1767225600000).toISOString(),
    );
    expect(updatedOf({})).toBeNull();
  });

  it('describes a file already on disk, which is what --adopt records', async () => {
    const out = join(dir, 'existing');
    mkdirSync(out, { recursive: true });
    // A file that is not a dump must be left alone by --adopt.
    writeFileSync(join(out, 'notes.txt'), 'x');
    writeFileSync(join(out, 'mriqc_api.T2w.json'), JSON.stringify(DATA.T2w, null, 2));
    const entry = await describeDump(out, 'mriqc_api.T2w.json', 'T2w');
    expect(entry.records).toBe(2);
    expect(entry.maxUpdated).toBe('2026-10-05T12:00:00.000Z');

    const added = await adopt({ out, log: () => undefined });
    expect(added.map((e) => e.file)).toEqual(['mriqc_api.T2w.json']);
    // Idempotent: a second adopt finds nothing new.
    expect(await adopt({ out, log: () => undefined })).toHaveLength(0);
  });
});
