/**
 * The per-request context: which database the procedures read.
 *
 * Keeping the handle in the context rather than reaching for a module singleton is
 * what lets the router tests run `createCaller` against a fixture DuckDB built in a
 * temporary directory, with no environment variable in sight.
 */

import { getDb, type Db } from '../db/instance.js';

/** Everything a procedure may reach for. */
export interface Context {
  readonly db: Db;
}

/** The context for an HTTP request: the process-wide database on `DUCKDB_PATH`. */
export function createContext(): Context {
  return { db: getDb() };
}
