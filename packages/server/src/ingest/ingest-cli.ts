#!/usr/bin/env node
/**
 * `pnpm --filter @mriqc/server ingest -- [--dumps <dir>] [--source dumps|mongo]
 * [--dry-run] [--no-verify] [--no-snapshot]`
 *
 * Runs one ingest against `DUCKDB_PATH` and exits. See `docs/backend-graph.md`,
 * "Ingest from dumps (decided 2026-10-08)".
 *
 * With no arguments it uses `INGEST_SOURCE` (default `dumps`) and
 * `MRIQC_DUMP_DIR`. `--dumps <dir>` names the directory explicitly and implies
 * the dump source; `--source mongo` pulls with the official driver, which needs
 * `MRIQC_MONGO_URI` in the environment.
 *
 * The server must not be running against the same file: DuckDB allows one writing
 * process at a time, and the CLI is that process for as long as it runs. The
 * nightly in-process schedule (`ingest/schedule.ts`) is how a *running* server
 * ingests.
 */

// First, and before anything that loads the DuckDB binding: libuv reads
// `UV_THREADPOOL_SIZE` once, the first time its threadpool is used.
import '../bootstrap.js';
import { DUCKDB_PATH, INGEST_SOURCE, MRIQC_MONGO_URI } from '../config.js';
import { Db } from '../db/instance.js';
import { ingest, type IngestOptions } from './ingest.js';
import { MongoSource } from './sources.js';

/** What the command line asked for. */
export interface CliOptions {
  source: 'dumps' | 'mongo';
  dumpsDir: string | null;
  dryRun: boolean;
  verify: boolean;
  snapshot: boolean;
}

/** Parse the CLI arguments. Exported so the parsing is unit-tested without a database. */
export function parseIngestArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    source: INGEST_SOURCE,
    dumpsDir: null,
    dryRun: false,
    verify: true,
    snapshot: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      // pnpm forwards the `--` separator itself; it is not an argument.
      case '--':
        break;
      case '--dumps':
        options.dumpsDir = next();
        options.source = 'dumps';
        break;
      case '--source': {
        const value = next();
        if (value !== 'dumps' && value !== 'mongo') {
          throw new Error(`--source must be "dumps" or "mongo", got ${JSON.stringify(value)}`);
        }
        options.source = value;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-verify':
        options.verify = false;
        break;
      case '--no-snapshot':
        options.snapshot = false;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.source === 'mongo' && options.dumpsDir !== null) {
    throw new Error('--dumps names a directory, which --source mongo does not read');
  }
  return options;
}

/**
 * The {@link IngestOptions} one parsed command line asks for.
 *
 * `--dumps` and the default dump directory both go through `MRIQC_DUMP_DIR`'s
 * resolution in `ingest()`, so the CLI does not have to know the default; only
 * `--source mongo` constructs a source itself, because that is the one choice the
 * configuration would not have made.
 */
export function ingestOptionsFor(
  cli: CliOptions,
  db: Db,
  log: (message: string) => void = (message) => console.log(message),
): IngestOptions {
  return {
    db,
    dryRun: cli.dryRun,
    verify: cli.verify,
    log,
    ...(cli.dumpsDir === null ? {} : { dumpsDir: cli.dumpsDir }),
    ...(cli.source === 'mongo'
      ? {
          source: new MongoSource({
            uri:
              MRIQC_MONGO_URI ??
              ((): never => {
                throw new Error('--source mongo needs MRIQC_MONGO_URI in the environment');
              })(),
            log,
          }),
        }
      : {}),
    ...(cli.snapshot ? {} : { snapshotDir: null }),
  };
}

const entry = process.argv[1] ?? '';
if (/ingest-cli\.(ts|js)$/.test(entry)) {
  const cli = parseIngestArgs(process.argv.slice(2));
  const db = new Db(DUCKDB_PATH, 1);
  try {
    const result = await ingest(ingestOptionsFor(cli, db));
    if (result.units.length === 0) console.log('ingest: nothing to do');
  } finally {
    await db.close();
  }
}
