/**
 * Process configuration, read once from the environment.
 *
 * See `docs/backend-graph.md`, "Package layout" and "Process and concurrency".
 * Every value has a default that makes `pnpm --filter @mriqc/server dev` work on
 * a developer machine with no environment set at all.
 */

import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package root, whether this file runs from `src/` under tsx/vitest or from
 * `dist/` after `tsc`. Both live exactly one directory below the package root.
 */
export const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Resolve against the package root so a relative default lands in `rewrite/data/`. */
function resolveFromPackage(value: string): string {
  return isAbsolute(value) ? value : resolve(PACKAGE_ROOT, value);
}

/**
 * The DuckDB file the server opens. The default puts it at `rewrite/data/mriqc.duckdb`,
 * which `rewrite/.gitignore` excludes. `build` writes it; nothing else does.
 */
export const DUCKDB_PATH: string = resolveFromPackage(
  envString('DUCKDB_PATH', '../../data/mriqc.duckdb'),
);

const envMemoryLimit = (name: string, fallback: string): string => {
  const value = envString(name, fallback);
  const match = /^(\d+(?:\.\d+)?)(KB|MB|GB|MiB|GiB)$/.exec(value);
  if (!match) {
    throw new Error(`${name} must be a positive memory limit (for example, 1GB)`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${name} must be a positive memory limit (for example, 1GB)`);
  }

  return value;
};

export const DUCKDB_MEMORY_LIMIT: string = envMemoryLimit('DUCKDB_MEMORY_LIMIT', '1GB');
export const INGEST_MEMORY_LIMIT: string = envMemoryLimit('INGEST_MEMORY_LIMIT', '4GB');
export const DUCKDB_THREADS: number = envInt(
  'DUCKDB_THREADS',
  Math.min(4, availableParallelism()),
  1,
  1024,
);
export const DUCKDB_TEMP_DIR: string = resolveFromPackage(
  envString('DUCKDB_TEMP_DIR', resolve(dirname(DUCKDB_PATH), 'tmp')),
);

/** Directory holding the flattened MRIQC Parquet dumps that `build` reads. */
export const MRIQC_DATA_DIR: string = envString(
  'MRIQC_DATA_DIR',
  'C:/Users/licc/projects/mriqc',
).replace(/\\/g, '/');

/** Port the HTTP server listens on. */
export const PORT: number = envInt('PORT', 8787, 1, 65535);

/* ----------------------------------------------------------------- ingest */

/**
 * Where ingest looks for dump files and their `manifest.json`
 * (`docs/backend-graph.md`, "Ingest from dumps"). The default sits beside the
 * database file, which `rewrite/.gitignore` excludes.
 */
export const MRIQC_DUMP_DIR: string = resolveFromPackage(
  envString('MRIQC_DUMP_DIR', '../../data/dumps'),
).replace(/\\/g, '/');

/**
 * Which {@link IngestSource} the scheduled job and a bare `ingest` CLI use.
 * `dumps` is the default and the owner's preference: the server never connects
 * to MongoDB unless it is told to.
 */
export const INGEST_SOURCE: 'dumps' | 'mongo' = ((): 'dumps' | 'mongo' => {
  const raw = envString('INGEST_SOURCE', 'dumps').toLowerCase();
  if (raw !== 'dumps' && raw !== 'mongo') {
    throw new Error(`INGEST_SOURCE must be "dumps" or "mongo", got ${JSON.stringify(raw)}`);
  }
  return raw;
})();

/**
 * The MongoDB connection string, read from the environment only.
 *
 * Never from a file in the repository: it carries a credential. Null when unset,
 * which is what makes the Mongo source refuse to start rather than connect to
 * something it guessed.
 */
export const MRIQC_MONGO_URI: string | null = ((): string | null => {
  const raw = process.env['MRIQC_MONGO_URI'];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
})();

/** The MongoDB database holding the four collections; the dumps say `mriqc_api`. */
export const MRIQC_MONGO_DB: string = envString('MRIQC_MONGO_DB', 'mriqc_api');

/** How many records one Mongo page carries before it is staged. */
export const MONGO_BATCH_SIZE: number = envInt('MONGO_BATCH_SIZE', 5_000, 1, 1_000_000);

/** Whether the nightly in-process ingest runs at all. Off unless explicitly `1`. */
export const INGEST_ENABLED: boolean = envString('INGEST_ENABLED', '0') === '1';

/** Local hour the nightly ingest starts, when it is enabled. */
export const INGEST_HOUR: number = envInt('INGEST_HOUR', 3, 0, 23);

/**
 * Where the post-ingest research snapshots go. Beside the database file, since a
 * `COPY FROM DATABASE` of it is what they are.
 */
export const SNAPSHOT_DIR: string = resolveFromPackage(
  envString('SNAPSHOT_DIR', resolve(DUCKDB_PATH, '..', 'snapshots')),
).replace(/\\/g, '/');

/** How many snapshots are kept; the design says the last three. */
export const SNAPSHOT_KEEP: number = envInt('SNAPSHOT_KEEP', 3, 1, 100);

/**
 * libuv's threadpool size as the environment set it, or null when it is unset or
 * unusable. Every DuckDB call occupies one of those threads, so it is the real
 * ceiling on concurrent reads; `bootstrap.ts` raises it when it can.
 */
function envThreadpoolSize(): number | null {
  const raw = process.env['UV_THREADPOOL_SIZE'];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The pool size a threadpool of `threadpoolSize` can actually serve: two threads
 * are left for `fs`, DNS and the writer connection, so pooled reads never starve
 * the rest of the process.
 */
export function poolSizeFor(requested: number, threadpoolSize: number | null): number {
  return threadpoolSize === null ? requested : Math.max(1, Math.min(requested, threadpoolSize - 2));
}

/**
 * Read connections in the pool. One per available CPU by default, which is what
 * the design calls for; reads are concurrent and each connection serves one query.
 * Capped at `UV_THREADPOOL_SIZE - 2` when the environment fixed that size, since a
 * connection beyond the threadpool's width can never run a statement anyway.
 */
export const READ_POOL_SIZE: number = poolSizeFor(
  envInt('READ_POOL_SIZE', Math.max(2, Math.min(16, availableParallelism())), 1, 64),
  envThreadpoolSize(),
);

/**
 * How many callers may wait for a pooled read connection before the pool starts
 * refusing. An unbounded queue turns an overload into unbounded latency for
 * everyone; refusing early lets the client see a retryable error instead.
 */
export const POOL_QUEUE_LIMIT: number = envInt('POOL_QUEUE_LIMIT', 64, 1, 4096);

/** How long a caller may wait for a connection before giving up. */
export const POOL_ACQUIRE_TIMEOUT_MS: number = envInt('POOL_ACQUIRE_TIMEOUT_MS', 10_000, 1, 600_000);

/** Procedure query budget before the connection is interrupted. */
export const QUERY_TIMEOUT_MS = 30_000;

/** Export query budget; exports stream for much longer than a procedure may. */
export const EXPORT_TIMEOUT_MS = 120_000;

/** Hard row cap on a single export response. */
export const EXPORT_ROW_CAP = 2_000_000;
