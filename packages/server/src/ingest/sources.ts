/**
 * Where ingest gets its records from.
 *
 * See `docs/backend-graph.md`, "Ingest from dumps (decided 2026-10-08)" and
 * "Ingest from MongoDB". Two sources feed the *same* ingest function:
 *
 * - {@link DumpDirSource} reads a directory of `mongoexport --jsonArray` files
 *   and the `manifest.json` that `tools/mriqc-dump/` writes beside them. A file
 *   whose sha256 is already in `ingest_log` is skipped. This is the default and
 *   the owner's preference: the server never connects to MongoDB.
 * - {@link MongoSource} connects with the official driver, using
 *   `MRIQC_MONGO_URI` from the environment and never from a file in the repo, and
 *   pages each collection by `_updated` from the watermark `ingest_log` already
 *   holds.
 *
 * Both yield {@link IngestUnit}s carrying records in the same MongoDB
 * extended-JSON shape, so everything downstream -- flatten, normalize, upsert,
 * canonical recompute, version bump, snapshot, `ingest_log` -- is written and
 * tested once. A unit either names a JSON file DuckDB can read directly, or
 * carries the records in memory for ingest to spill to a temporary file; the two
 * stage identically.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MONGO_BATCH_SIZE, MRIQC_MONGO_DB } from '../config.js';
import { INGEST_COLLECTIONS, isIngestCollection, type IngestCollection } from './flatten.js';

/* ------------------------------------------------------------------ units */

/** One batch of records to stage, from either source. */
export interface IngestUnit {
  readonly collection: IngestCollection;
  /**
   * The dump file name, or null for a Mongo page. Recorded in `ingest_log` so a
   * row says which file it came from.
   */
  readonly file: string | null;
  /**
   * The dump file's content hash, or null for a Mongo page. This is the key
   * ingest skips on, which is why a watermark source has none: its idempotency
   * comes from the `_updated` window and the "newer replaces" upsert instead.
   */
  readonly sha256: string | null;
  /** An absolute path DuckDB can `read_json`, when the unit is already a file. */
  readonly path?: string;
  /** The records themselves, when the unit came from a driver rather than a file. */
  readonly records?: readonly unknown[];
  /** How many records the unit holds, when the source knows without reading it. */
  readonly recordCount?: number;
  /** The `_updated` window the unit was selected by, for the log. */
  readonly window?: { readonly lo: string | null; readonly hi: string | null };
}

/** What ingest already knows, so a source can select only what is new. */
export interface IngestState {
  /** Every `sha256` in `ingest_log`. A file source skips these. */
  readonly knownHashes: ReadonlySet<string>;
  /** The highest `_updated` ingested per collection. A watermark source resumes here. */
  readonly watermarks: ReadonlyMap<IngestCollection, Date>;
}

/** A source of records for {@link ingest}. */
export interface IngestSource {
  readonly kind: 'dumps' | 'mongo';
  /** One line naming what this source will read, for the log. */
  describe(): string;
  /** The units to ingest, oldest `_updated` first. */
  units(state: IngestState): AsyncIterable<IngestUnit>;
  /** Release anything the source opened. Always called, even on failure. */
  close(): Promise<void>;
}

/* --------------------------------------------------------------- manifest */

/** One `manifest.json` entry, as `tools/mriqc-dump/` writes it. */
export interface ManifestEntry {
  readonly file: string;
  readonly collection: IngestCollection;
  readonly records: number;
  /** The highest `_updated` in the file, ISO-8601, or null when the file is empty. */
  readonly maxUpdated: string | null;
  /** The `_updated` the export filtered on, ISO-8601, or null for "everything". */
  readonly since?: string | null;
  readonly sha256: string;
  readonly bytes?: number;
  readonly exportedAt?: string;
}

/** The manifest of a dump directory. */
export interface DumpManifest {
  readonly version: number;
  readonly files: readonly ManifestEntry[];
}

/** The manifest's file name, shared with the dump tool. */
export const MANIFEST_FILE = 'manifest.json';

/** Parse and validate a `manifest.json`. A malformed manifest is an error, not a skip. */
export function parseManifest(text: string): DumpManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as DumpManifest).files)) {
    throw new Error(`${MANIFEST_FILE} must be an object with a "files" array`);
  }
  const files = (parsed as { files: readonly unknown[] }).files.map((raw, index) => {
    const entry = raw as Partial<ManifestEntry>;
    const where = `${MANIFEST_FILE} files[${index}]`;
    if (typeof entry.file !== 'string' || entry.file === '') throw new Error(`${where}.file missing`);
    if (typeof entry.collection !== 'string' || !isIngestCollection(entry.collection)) {
      throw new Error(
        `${where}.collection must be one of ${INGEST_COLLECTIONS.join(', ')}, got ` +
          JSON.stringify(entry.collection),
      );
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`${where}.sha256 must be a 64-character hex digest`);
    }
    // A manifest entry must not name anything but a file beside the manifest: it
    // is read as a path, and `../` in it would reach outside the dump directory.
    if (basename(entry.file) !== entry.file) {
      throw new Error(`${where}.file must be a bare file name, got ${JSON.stringify(entry.file)}`);
    }
    return {
      file: entry.file,
      collection: entry.collection,
      records: typeof entry.records === 'number' ? entry.records : 0,
      maxUpdated: typeof entry.maxUpdated === 'string' ? entry.maxUpdated : null,
      since: typeof entry.since === 'string' ? entry.since : null,
      sha256: entry.sha256,
      ...(typeof entry.bytes === 'number' ? { bytes: entry.bytes } : {}),
      ...(typeof entry.exportedAt === 'string' ? { exportedAt: entry.exportedAt } : {}),
    } satisfies ManifestEntry;
  });
  return { version: typeof (parsed as DumpManifest).version === 'number' ? (parsed as DumpManifest).version : 1, files };
}

/** The sha256 of a file, streamed so a multi-gigabyte dump is not read into memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Manifest entries in the order they must be applied: oldest `_updated` first,
 * then by file name, so a later file's re-sent record always wins the upsert.
 */
export function orderedEntries(manifest: DumpManifest): ManifestEntry[] {
  return [...manifest.files].sort((a, b) => {
    const left = a.maxUpdated ?? '';
    const right = b.maxUpdated ?? '';
    return left === right ? a.file.localeCompare(b.file) : left.localeCompare(right);
  });
}

/* ------------------------------------------------------- the dump directory */

/** Options for {@link DumpDirSource}. */
export interface DumpDirOptions {
  /** Recompute each file's sha256 before trusting the manifest. On by default. */
  verify?: boolean;
  log?: (message: string) => void;
}

/**
 * The default source: a directory of dated `mongoexport --jsonArray` files and
 * the manifest beside them.
 *
 * The manifest's sha256 is what ingest skips on, so by default it is *recomputed*
 * rather than trusted: a stale digest would silently skip a file or re-ingest one,
 * and hashing is a fraction of the time staging the same bytes takes. `--no-verify`
 * trades that check for the read.
 */
export class DumpDirSource implements IngestSource {
  readonly kind = 'dumps' as const;
  readonly #dir: string;
  readonly #verify: boolean;
  readonly #log: (message: string) => void;

  constructor(dir: string, options: DumpDirOptions = {}) {
    this.#dir = dir.replace(/\\/g, '/').replace(/\/$/, '');
    this.#verify = options.verify ?? true;
    this.#log = options.log ?? ((): void => undefined);
  }

  describe(): string {
    return `dump directory ${this.#dir}`;
  }

  async *units(state: IngestState): AsyncIterable<IngestUnit> {
    const manifestPath = join(this.#dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      throw new Error(
        `no ${MANIFEST_FILE} in ${this.#dir}; run mriqc-dump against it, or` +
          ' mriqc-dump --adopt to take existing full dumps as the first files',
      );
    }
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    for (const entry of orderedEntries(manifest)) {
      const path = join(this.#dir, entry.file);
      if (!existsSync(path)) {
        throw new Error(`${MANIFEST_FILE} names ${entry.file}, which is not in ${this.#dir}`);
      }
      let sha256 = entry.sha256;
      if (this.#verify) {
        sha256 = await sha256File(path);
        if (sha256 !== entry.sha256) {
          throw new Error(
            `${entry.file} hashes to ${sha256} but ${MANIFEST_FILE} says ${entry.sha256};` +
              ' the manifest and the directory have parted company',
          );
        }
      }
      if (state.knownHashes.has(sha256)) {
        this.#log(`  skip ${entry.file}: already in ingest_log`);
        continue;
      }
      yield {
        collection: entry.collection,
        file: entry.file,
        sha256,
        path,
        recordCount: entry.records,
        window: { lo: entry.since ?? null, hi: entry.maxUpdated },
      };
    }
  }

  async close(): Promise<void> {
    // Nothing is held open: each file is handed to DuckDB as a path.
  }
}

/* ---------------------------------------------------------------- MongoDB */

/** Options for {@link MongoSource}. */
export interface MongoSourceOptions {
  /** The connection string. Required, and read from the environment by the caller. */
  uri: string;
  /** The database holding the four collections; `mriqc_api` by default. */
  database?: string;
  /** Records per staged page. */
  batchSize?: number;
  /** Which collections to pull; all four by default. */
  collections?: readonly IngestCollection[];
  log?: (message: string) => void;
}

/**
 * The minimum of the `mongodb` driver this module uses, so the import can be
 * dynamic. The driver is a dependency, but the default source does not need it
 * and a server that never pulls from Mongo should not pay to load it.
 */
interface MongoLike {
  db(name?: string): {
    collection(name: string): {
      find(filter: unknown, options?: unknown): {
        sort(spec: unknown): {
          batchSize(n: number): AsyncIterable<Record<string, unknown>>;
        };
      };
    };
  };
  close(): Promise<void>;
}

/**
 * Pull records straight from MongoDB, resuming from what `ingest_log` recorded.
 *
 * The filter is `_updated >= watermark`, not `>`: `>` would silently drop a
 * record whose `_updated` ties the highest one already ingested, and a re-sent
 * record costs nothing because the upsert only replaces a row when the incoming
 * `updated_at` is strictly newer. A page that changes nothing is logged and left
 * out of the `data_version` digest, so a nightly pull that finds nothing new is a
 * genuine no-op.
 *
 * Records are handed on as *relaxed* extended JSON -- the shape
 * `mongoexport --jsonArray` writes -- so the dump path and this one stage the
 * identical text.
 */
export class MongoSource implements IngestSource {
  readonly kind = 'mongo' as const;
  readonly #options: Required<Omit<MongoSourceOptions, 'log'>> & { log: (m: string) => void };
  #client: MongoLike | null = null;

  constructor(options: MongoSourceOptions) {
    if (options.uri.trim() === '') {
      throw new Error('MongoSource needs a connection string; set MRIQC_MONGO_URI');
    }
    this.#options = {
      uri: options.uri,
      database: options.database ?? MRIQC_MONGO_DB,
      batchSize: options.batchSize ?? MONGO_BATCH_SIZE,
      collections: options.collections ?? INGEST_COLLECTIONS,
      log: options.log ?? ((): void => undefined),
    };
  }

  describe(): string {
    // Never the URI: it carries a credential, and this string is logged.
    return `MongoDB database ${this.#options.database} (${this.#options.collections.join(', ')})`;
  }

  async *units(state: IngestState): AsyncIterable<IngestUnit> {
    // One dynamic import, and `EJSON` out of the driver's own re-export rather
    // than out of `bson` directly: `bson` is the driver's dependency, not ours,
    // and importing it by name would reach into another package's tree.
    const driver = (await import('mongodb')) as unknown as {
      MongoClient: new (uri: string) => MongoLike & { connect(): Promise<unknown> };
      EJSON: { serialize(value: unknown, options?: { relaxed?: boolean }): Record<string, unknown> };
    };
    const { MongoClient, EJSON } = driver;

    const client = new MongoClient(this.#options.uri);
    await client.connect();
    this.#client = client;
    const database = client.db(this.#options.database);

    for (const collection of this.#options.collections) {
      const watermark = state.watermarks.get(collection) ?? null;
      const filter = watermark === null ? {} : { _updated: { $gte: watermark } };
      const cursor = database
        .collection(`${collection}`)
        .find(filter, { batchSize: this.#options.batchSize })
        .sort({ _updated: 1 })
        .batchSize(this.#options.batchSize);

      let page: Record<string, unknown>[] = [];
      let pages = 0;
      let total = 0;
      const flush = (): IngestUnit | null => {
        if (page.length === 0) return null;
        pages += 1;
        total += page.length;
        const records = page.map((document) => EJSON.serialize(document, { relaxed: true }));
        const hi = lastUpdatedOf(page[page.length - 1]);
        const lo = lastUpdatedOf(page[0]);
        page = [];
        return {
          collection,
          file: null,
          sha256: null,
          records,
          recordCount: records.length,
          window: { lo, hi },
        };
      };

      for await (const document of cursor) {
        page.push(document);
        if (page.length >= this.#options.batchSize) {
          const unit = flush();
          if (unit !== null) yield unit;
        }
      }
      const last = flush();
      if (last !== null) yield last;
      this.#options.log(
        `  ${collection}: ${total} record(s) in ${pages} page(s)` +
          `${watermark === null ? ' (everything)' : ` since ${watermark.toISOString()}`}`,
      );
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    await client?.close();
  }
}

/** The `_updated` of one driver document as ISO text, or null when it has none. */
function lastUpdatedOf(document: Record<string, unknown> | undefined): string | null {
  const value = document?.['_updated'];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * A source over records already in memory.
 *
 * It is how the test suite proves the two real sources are interchangeable -- the
 * same records, once through a dump file and once through this -- and it is the
 * shape `MongoSource` reduces to once the driver has handed over its page, so
 * testing against it tests the whole downstream.
 */
export class RecordsSource implements IngestSource {
  readonly kind: 'dumps' | 'mongo';
  readonly #pages: readonly { collection: IngestCollection; records: readonly unknown[] }[];

  constructor(
    pages: readonly { collection: IngestCollection; records: readonly unknown[] }[],
    kind: 'dumps' | 'mongo' = 'mongo',
  ) {
    this.#pages = pages;
    this.kind = kind;
  }

  describe(): string {
    return `${this.#pages.length} in-memory page(s)`;
  }

  async *units(): AsyncIterable<IngestUnit> {
    for (const page of this.#pages) {
      yield {
        collection: page.collection,
        file: null,
        sha256: null,
        records: page.records,
        recordCount: page.records.length,
        window: { lo: null, hi: null },
      };
    }
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
