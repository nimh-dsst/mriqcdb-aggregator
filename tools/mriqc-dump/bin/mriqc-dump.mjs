#!/usr/bin/env node
/**
 * The `mriqc-dump` entry point. See `../README.md` and `../src/dump.mjs`.
 *
 * Usage:
 *   mriqc-dump --uri "$MRIQC_MONGO_URI" --out /srv/mriqc/dumps [--since <iso>]
 *              [--db mriqc_api] [--collection T2w]... [--dry-run]
 *   mriqc-dump --adopt --out /srv/mriqc/dumps
 */

import { adopt, COLLECTIONS, dump } from '../src/dump.mjs';

const USAGE = `mriqc-dump --uri <uri> --out <dir> [options]

  --uri <uri>          MongoDB connection string. Defaults to $MRIQC_MONGO_URI.
  --out <dir>          Where the dump files and manifest.json live. Required.
  --since <iso>        Override the manifest watermark for every collection.
  --db <name>          Database name, when the URI does not carry one.
  --collection <name>  Export only this collection; repeatable.
                       Default: ${COLLECTIONS.join(', ')}.
  --mongoexport <path> The mongoexport binary. Defaults to $MRIQC_MONGOEXPORT
                       or "mongoexport" on PATH.
  --adopt              Do not export; take the dump files already in --out into
                       the manifest, so existing full dumps become first files.
  --dry-run            Print the mongoexport command lines and change nothing.
  -h, --help           This text.
`;

/**
 * Parse the command line.
 *
 * @param {readonly string[]} argv
 * @returns {Record<string, unknown>}
 */
export function parseArgs(argv) {
  /** @type {{ uri: string | null, out: string | null, since: string | null, db: string | null,
   *           collections: string[], dryRun: boolean, adopt: boolean, help: boolean,
   *           mongoexport: string | null }} */
  const options = {
    uri: process.env.MRIQC_MONGO_URI ?? null,
    out: null,
    since: null,
    db: null,
    collections: [],
    dryRun: false,
    adopt: false,
    help: false,
    mongoexport: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--':
        break;
      case '--uri':
        options.uri = next();
        break;
      case '--out':
        options.out = next();
        break;
      case '--since':
        options.since = next();
        break;
      case '--db':
        options.db = next();
        break;
      case '--collection': {
        const value = next();
        if (!COLLECTIONS.includes(value)) {
          throw new Error(`--collection must be one of ${COLLECTIONS.join(', ')}, got ${value}`);
        }
        options.collections.push(value);
        break;
      }
      case '--mongoexport':
        options.mongoexport = next();
        break;
      case '--adopt':
        options.adopt = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.since !== null && Number.isNaN(Date.parse(options.since))) {
    throw new Error(`--since must be an ISO-8601 timestamp, got ${JSON.stringify(options.since)}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (options.out === null) {
  console.error(USAGE);
  process.exit(2);
}

if (options.adopt) {
  await adopt({ out: /** @type {string} */ (options.out) });
} else {
  await dump({
    uri: /** @type {string} */ (options.uri ?? ''),
    out: /** @type {string} */ (options.out),
    since: /** @type {string | null} */ (options.since),
    db: /** @type {string | null} */ (options.db),
    dryRun: /** @type {boolean} */ (options.dryRun),
    ...(Array.isArray(options.collections) && options.collections.length > 0
      ? { collections: options.collections }
      : {}),
    ...(options.mongoexport === null ? {} : { mongoexport: options.mongoexport }),
  });
}
