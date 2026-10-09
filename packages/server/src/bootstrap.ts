/**
 * Threadpool sizing. Imported first by every entry point, before anything that
 * loads the DuckDB binding.
 *
 * Every `@duckdb/node-api` call runs as a `Napi::AsyncWorker` on libuv's
 * threadpool, whose default size is 4. A read pool of 16 connections is therefore
 * throttled to 4 concurrent statements, and those four workers are the same four
 * that serve `fs` reads and DNS -- so a few slow aggregations stall static files
 * and health checks too.
 *
 * libuv reads `UV_THREADPOOL_SIZE` once, the first time the threadpool is
 * initialized, and ignores every later change. Setting it here works only because
 * this module is evaluated before the binding loads and before anything in the
 * process has used the threadpool. That is a best-effort fallback for development:
 * **in production the variable must be set in the environment** (systemd unit,
 * container env, or the shell that starts the process), since any threadpool use
 * during Node's own start-up would freeze the default size before this line runs.
 */

import { READ_POOL_SIZE } from './config.js';

/** The environment variable libuv reads its threadpool size from. */
export const UV_THREADPOOL_ENV = 'UV_THREADPOOL_SIZE';

/** libuv's own default, which is what we are raising. */
export const UV_THREADPOOL_DEFAULT = 4;

/**
 * The size the threadpool should have for a read pool of `poolSize`: every pooled
 * connection may hold a worker, plus headroom for `fs`, DNS and the writer. An
 * `existing` value set by the environment always wins -- it is the only one libuv
 * is guaranteed to have seen.
 */
export function chooseThreadpoolSize(poolSize: number, existing: string | undefined): number {
  if (existing !== undefined && existing.trim() !== '') {
    const parsed = Number(existing);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return Math.max(UV_THREADPOOL_DEFAULT, poolSize + 4);
}

process.env[UV_THREADPOOL_ENV] = String(
  chooseThreadpoolSize(READ_POOL_SIZE, process.env[UV_THREADPOOL_ENV]),
);

/** The threadpool size this process will run with. */
export const UV_THREADPOOL_SIZE: number = Number(process.env[UV_THREADPOOL_ENV]);
