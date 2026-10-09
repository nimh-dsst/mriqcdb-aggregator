#!/usr/bin/env node
/**
 * `pnpm --filter @mriqc/server build:db [-- --sample N] [--data-dir DIR]
 * [--from-dumps DIR] [--out FILE] [--memory-limit SIZE] [--threads N] [--canonical-from-parquet]`
 *
 * Builds the serving DuckDB file from JSON dumps or a Parquet directory. `--sample N` loads
 * only the first N rows of each observation table, which turns a minutes-long
 * full build into a seconds-long development one.
 *
 * The canonical tables are computed from the policies, which is the bulk of a
 * full build's time and all of its memory pressure, so `--memory-limit` and
 * `--threads` are first-class: they go straight into the writer's DuckDB
 * settings. `--memory-limit` defaults to about 60% of what the OS reports free,
 * so a build never pushes the machine into swap. `--canonical-from-parquet`
 * loads the published artifacts instead of computing anything, for comparing the
 * two side by side.
 */

// First, and before anything that loads the DuckDB binding: libuv reads
// `UV_THREADPOOL_SIZE` once, the first time its threadpool is used.
import '../bootstrap.js';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from './build.js';

/**
 * About 60% of what the OS reports free. The same rule as the validation
 * harness, which has to share the machine with a live server; a build that takes
 * DuckDB's default 80% of *physical* RAM is what makes a desktop unusable for
 * the ten minutes the canonicalization runs.
 */
function defaultMemoryLimit(): string {
  const gib = (freemem() / 1024 ** 3) * 0.6;
  return `${Math.max(1, Math.floor(gib * 10) / 10)}GiB`;
}

export function parseArgs(argv: readonly string[]): {
  sample: number | null;
  dataDir?: string;
  fromDumps?: string;
  outPath?: string;
  settings: Record<string, string>;
  canonicalFromParquet: boolean;
} {
  let sample: number | null = null;
  let dataDir: string | undefined;
  let fromDumps: string | undefined;
  let outPath: string | undefined;
  let memoryLimit: string | undefined;
  let threads: string | undefined;
  let canonicalFromParquet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      // pnpm forwards the `--` separator itself; it is not an argument.
      case '--':
        break;
      case '--sample': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error('--sample needs a positive integer');
        }
        sample = parsed;
        break;
      }
      case '--data-dir':
        dataDir = next();
        break;
      case '--from-dumps':
        fromDumps = next();
        break;
      case '--out':
        outPath = next();
        break;
      case '--memory-limit':
        memoryLimit = next();
        break;
      case '--threads':
        threads = next();
        break;
      case '--canonical-from-parquet':
        canonicalFromParquet = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (fromDumps !== undefined && dataDir !== undefined) {
    throw new Error('--from-dumps cannot be combined with --data-dir');
  }
  if (fromDumps !== undefined && canonicalFromParquet) {
    throw new Error('--from-dumps cannot be combined with --canonical-from-parquet');
  }
  return {
    sample,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(fromDumps === undefined ? {} : {
      fromDumps: resolve(process.env['INIT_CWD'] ?? process.cwd(), fromDumps),
    }),
    ...(outPath === undefined ? {} : {
      outPath: fromDumps === undefined ? outPath : resolve(process.env['INIT_CWD'] ?? process.cwd(), outPath),
    }),
    settings: {
      memory_limit: memoryLimit ?? defaultMemoryLimit(),
      ...(threads === undefined ? {} : { threads }),
    },
    canonicalFromParquet,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `build:db: canonical from ${options.canonicalFromParquet ? 'the Parquet artifacts' : 'the policy views'}` +
      `, memory_limit ${options.settings['memory_limit']}`,
  );
  await buildDatabase(options);
}
