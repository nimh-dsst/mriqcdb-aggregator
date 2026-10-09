/**
 * One `DuckDBInstance` per process, a pool of read connections, and a single
 * writer connection behind an in-process mutex.
 *
 * See `docs/backend-graph.md`, "Process and concurrency": reads are concurrent,
 * ingest is serialized, and a query that outruns its budget is stopped with
 * DuckDB's `interrupt` rather than left to occupy a connection.
 */

import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { mkdirSync } from 'node:fs';
import {
  DUCKDB_MEMORY_LIMIT,
  DUCKDB_PATH,
  DUCKDB_TEMP_DIR,
  DUCKDB_THREADS,
  POOL_ACQUIRE_TIMEOUT_MS,
  POOL_QUEUE_LIMIT,
  QUERY_TIMEOUT_MS,
  READ_POOL_SIZE,
} from '../config.js';

/** A result row as the templates hand it back: column name to JS value. */
export type Row = Record<string, unknown>;

/** Anything a positional `?` parameter may be bound to before conversion. */
export type ParamValue = string | number | boolean | bigint | Date | null | undefined;

/** Thrown when a query was interrupted because it ran past its timeout. */
export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`query exceeded its ${timeoutMs} ms budget and was interrupted`);
    this.name = 'QueryTimeoutError';
  }
}

/** Thrown when the read pool has no connection and the wait queue is full or expired. */
export class PoolBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolBusyError';
  }
}

/** Thrown when the caller's `AbortSignal` fired before or during the query. */
export class QueryAbortedError extends Error {
  constructor() {
    super('the client aborted the request before the query finished');
    this.name = 'QueryAbortedError';
  }
}

/**
 * Thrown when DuckDB reported a fatal exception. DuckDB invalidates the whole
 * `DatabaseInstance` on one of these, after which every connection answers
 * "database has been invalidated", so the instance is dropped and reopened rather
 * than left to answer every later request with the same error.
 */
export class DatabaseInvalidatedError extends Error {
  constructor(override readonly cause: unknown) {
    super('the DuckDB instance was invalidated by a fatal error and has been reopened');
    this.name = 'DatabaseInvalidatedError';
  }
}

/**
 * Convert one JS parameter to the value DuckDB binds for a positional `?`.
 *
 * `undefined` and `null` both bind SQL NULL; a `Date` binds as a timestamp
 * through its ISO text, which DuckDB casts at the placeholder's inferred type.
 * `bigint` passes through so a BIGINT keyset cursor keeps full precision.
 */
function toDuckDBValue(value: ParamValue): DuckDBValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Bind a statement's positional `?` parameters, in order. */
export function bindParams(params: readonly ParamValue[]): DuckDBValue[] {
  return params.map(toDuckDBValue);
}

/**
 * DuckDB reports an interrupted query as an `INTERRUPT` error. The interrupt we
 * issued is the only source of one in this process, so the message is enough to
 * tell a timeout from a genuine query error.
 */
function wasInterrupted(error: unknown): boolean {
  return error instanceof Error && /interrupt/i.test(error.message);
}

/**
 * Whether an error is one of the fatal classes that take the whole DuckDB
 * instance down with them. Anything else is an ordinary query failure and leaves
 * the connection perfectly usable.
 */
export function isFatalDuckDBError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /has been invalidated|FATAL Error|INTERNAL Error/i.test(error.message)
  );
}

/** How often a timed-out call re-issues its interrupt until the native call returns. */
const REINTERRUPT_MS = 25;

/** A connection plus the timeout wrapper every query on it goes through. */
export interface DbConnection {
  /** Run `sql` with positional parameters and materialize every row. */
  all(sql: string, params?: readonly ParamValue[]): Promise<Row[]>;
  /** Run `sql` for its effect, discarding any result. */
  exec(sql: string, params?: readonly ParamValue[]): Promise<void>;
  /** The raw DuckDB connection, for streaming reads that must not materialize. */
  readonly raw: DuckDBConnection;
}

function wrap(connection: DuckDBConnection): DbConnection {
  return {
    raw: connection,
    async all(sql, params) {
      const reader = await connection.runAndReadAll(sql, bindParams(params ?? []));
      return reader.getRowObjectsJS() as Row[];
    },
    async exec(sql, params) {
      await connection.run(sql, bindParams(params ?? []));
    },
  };
}

/** What a pooled read may be given besides the function to run. */
export interface ReadOptions {
  /** Budget for acquiring a connection *and* running the query. */
  timeoutMs?: number;
  /** The caller's abort signal; aborting removes a waiter and interrupts a runner. */
  signal?: AbortSignal;
}

function readOptions(options: number | ReadOptions | undefined): {
  timeoutMs: number;
  signal: AbortSignal | undefined;
} {
  if (typeof options === 'number') return { timeoutMs: options, signal: undefined };
  return { timeoutMs: options?.timeoutMs ?? QUERY_TIMEOUT_MS, signal: options?.signal };
}

/** One in-flight call: what the caller awaits, and when the native call really ended. */
interface TimedRun<T> {
  value: Promise<T>;
  /** Resolves with the query's own error, or `undefined`, once the call has returned. */
  finished: Promise<unknown>;
}

/**
 * Run `fn` against `connection`, interrupting it if it outruns `timeoutMs`.
 *
 * A single `interrupt()` is not enough. DuckDB's `Prepare()`/`PendingQuery()`
 * clear the interrupt flag on entry, and the extract, prepare, execute and fetch
 * phases are separate async native calls, so an interrupt that lands between two
 * of them is simply wiped and the statement then runs with no budget at all. Two
 * things make the timeout reliable: the call is raced against a rejecting timer,
 * so the caller always hears about it, and the interrupt is re-issued every
 * {@link REINTERRUPT_MS} until the native call actually returns, so whichever
 * phase is running next sees it.
 *
 * `finished` is what the pool waits on before re-using the connection: a timed-out
 * statement is still executing on it after the caller has given up.
 */
function runWithTimeout<T>(
  connection: DuckDBConnection,
  timeoutMs: number,
  fn: (connection: DbConnection) => Promise<T>,
  signal?: AbortSignal,
): TimedRun<T> {
  let work: Promise<T>;
  try {
    work = fn(wrap(connection));
  } catch (error) {
    work = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const finished: Promise<unknown> = work.then(
    () => undefined,
    (error: unknown) => error,
  );

  let timedOut = false;
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;
  let repeat: NodeJS.Timeout | undefined;

  const stopInterrupting = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (repeat !== undefined) clearInterval(repeat);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  };

  const keepInterrupting = (): void => {
    connection.interrupt();
    repeat ??= setInterval(() => connection.interrupt(), REINTERRUPT_MS);
  };

  const onAbort =
    signal === undefined
      ? undefined
      : (): void => {
          aborted = true;
          keepInterrupting();
        };
  if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true });

  const expiry = new Promise<never>((_resolve, reject) => {
    if (!Number.isFinite(timeoutMs)) return;
    timer = setTimeout(() => {
      timedOut = true;
      keepInterrupting();
      reject(new QueryTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const value = (async () => {
    try {
      return await Promise.race([work, expiry]);
    } catch (error) {
      if (timedOut && (wasInterrupted(error) || error instanceof QueryTimeoutError)) {
        throw new QueryTimeoutError(timeoutMs);
      }
      if (aborted && wasInterrupted(error)) throw new QueryAbortedError();
      throw error;
    }
  })();
  // The interrupt must keep landing until the *native* call returns, which is
  // after the caller has already been handed its timeout.
  void finished.then(stopInterrupting, stopInterrupting);
  return { value, finished };
}

/** One parked caller waiting for a connection to come back to the pool. */
interface Waiter {
  resolve: (connection: DuckDBConnection) => void;
  reject: (error: Error) => void;
  settle: () => void;
}

/** A DuckDB file opened once, with a read pool and a serialized writer. */
export class Db {
  readonly path: string;

  #instance: Promise<DuckDBInstance> | undefined;
  #idle: DuckDBConnection[] = [];
  #open = 0;
  #waiting: Waiter[] = [];
  #writer: DuckDBConnection | undefined;
  /** Serializes writers: every `withWriter` call chains onto the previous one. */
  #writeLock: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    path: string,
    readonly poolSize: number = READ_POOL_SIZE,
    readonly queueLimit: number = POOL_QUEUE_LIMIT,
  ) {
    this.path = path;
  }

  /** How many callers are parked waiting for a connection. Exposed for tests. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** How many connections the pool has opened. Exposed for tests. */
  get openConnections(): number {
    return this.#open;
  }

  #getInstance(): Promise<DuckDBInstance> {
    if (this.#closed) throw new Error(`database ${this.path} is closed`);
    if (this.#instance === undefined) {
      // A create that rejects must not be cached: the file may simply not exist
      // yet, or `build:db` may be mid-rename, and a later call should retry rather
      // than replay the first failure for the life of the process.
      const creating = (async () => {
        mkdirSync(DUCKDB_TEMP_DIR, { recursive: true });
        const instance = await DuckDBInstance.create(this.path);
        try {
          const connection = await instance.connect();
          try {
            // These are GLOBAL settings: every pooled reader and the writer
            // inherit them, including connections opened after this one closes.
            await connection.run('SET memory_limit = ?', [DUCKDB_MEMORY_LIMIT]);
            await connection.run('SET threads = ?', [DUCKDB_THREADS]);
            await connection.run('SET temp_directory = ?', [DUCKDB_TEMP_DIR]);
            const settings = await connection.runAndReadAll(
              `SELECT current_setting('memory_limit') AS memory_limit,
                      current_setting('threads') AS threads,
                      current_setting('temp_directory') AS temp_directory`,
            );
            console.log('[duckdb]', settings.getRowObjectsJS()[0]);
          } finally {
            connection.closeSync();
          }
          return instance;
        } catch (error) {
          instance.closeSync();
          throw error;
        }
      })();
      this.#instance = creating;
      creating.catch(() => {
        if (this.#instance === creating) this.#instance = undefined;
      });
    }
    return this.#instance;
  }

  /**
   * Drop the instance after a fatal error so the next call reopens the file.
   * Every connection of an invalidated instance answers the same error, so
   * keeping them would turn one engine fault into a permanent outage.
   */
  #invalidate(): void {
    const instance = this.#instance;
    this.#instance = undefined;
    for (const connection of this.#idle.splice(0)) {
      try {
        connection.closeSync();
      } catch {
        // An invalidated connection may refuse to close; there is nothing to do.
      }
    }
    this.#open = 0;
    this.#writer = undefined;
    for (const waiter of this.#waiting.splice(0)) {
      waiter.settle();
      waiter.reject(new PoolBusyError('the database was reopened after a fatal error'));
    }
    void instance?.then(
      (resolved) => {
        try {
          resolved.closeSync();
        } catch {
          // Likewise.
        }
      },
      () => undefined,
    );
  }

  async #acquire(timeoutMs: number, signal?: AbortSignal): Promise<DuckDBConnection> {
    if (signal?.aborted === true) throw new QueryAbortedError();
    const idle = this.#idle.pop();
    if (idle !== undefined) return idle;
    if (this.#open < this.poolSize) {
      this.#open += 1;
      try {
        return await (await this.#getInstance()).connect();
      } catch (error) {
        this.#open -= 1;
        throw error;
      }
    }
    if (this.#waiting.length >= this.queueLimit) {
      throw new PoolBusyError(
        `the read pool is saturated: ${this.#waiting.length} callers already waiting`,
      );
    }
    return this.#park(timeoutMs, signal);
  }

  /**
   * Park until a connection is released, the deadline passes, or the caller
   * aborts. A waiter that gives up is removed from the queue, so a browser that
   * navigated away never later acquires a connection to run for nobody.
   */
  #park(timeoutMs: number, signal?: AbortSignal): Promise<DuckDBConnection> {
    const deadline = Math.min(
      POOL_ACQUIRE_TIMEOUT_MS,
      Number.isFinite(timeoutMs) ? timeoutMs : POOL_ACQUIRE_TIMEOUT_MS,
    );
    return new Promise<DuckDBConnection>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        remove();
        reject(new QueryAbortedError());
      };
      const settle = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = { resolve, reject, settle };
      const remove = (): void => {
        settle();
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
      };
      timer = setTimeout(() => {
        remove();
        reject(new PoolBusyError(`waited ${deadline} ms for a read connection`));
      }, deadline);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  #release(connection: DuckDBConnection, error: unknown): void {
    if (isFatalDuckDBError(error)) {
      // The instance, not just this connection, is gone. Reopen rather than hand
      // the poisoned connection to the next caller.
      this.#invalidate();
      return;
    }
    if (this.#closed) {
      try {
        connection.closeSync();
      } catch {
        // Closing twice is not worth reporting.
      }
      this.#open = Math.max(0, this.#open - 1);
      return;
    }
    const next = this.#waiting.shift();
    if (next !== undefined) {
      next.settle();
      next.resolve(connection);
    } else this.#idle.push(connection);
  }

  /**
   * Run `fn` on a pooled read connection. Concurrent calls run concurrently up to
   * `poolSize`; beyond that they queue, bounded by `queueLimit` and by the
   * acquire deadline. The connection goes back to the pool only once the native
   * call has really finished -- a timed-out statement is still running on it when
   * the caller is handed its {@link QueryTimeoutError} -- and a connection whose
   * query failed fatally is dropped rather than re-pooled.
   */
  async withRead<T>(
    fn: (connection: DbConnection) => Promise<T>,
    options?: number | ReadOptions,
  ): Promise<T> {
    const { timeoutMs, signal } = readOptions(options);
    const started = Date.now();
    const connection = await this.#acquire(timeoutMs, signal);
    // The wait counts against the budget, so end-to-end latency stays bounded.
    const remaining = Number.isFinite(timeoutMs)
      ? Math.max(1, timeoutMs - (Date.now() - started))
      : timeoutMs;
    const run = runWithTimeout(connection, remaining, fn, signal);
    void run.finished.then((error) => this.#release(connection, error));
    try {
      return await run.value;
    } catch (error) {
      if (isFatalDuckDBError(error)) throw new DatabaseInvalidatedError(error);
      throw error;
    }
  }

  /**
   * Run `fn` on the single writer connection, holding an in-process mutex for the
   * whole call. Ingest wraps its transaction in one of these, so readers on pooled
   * connections never see a half-loaded table.
   */
  async withWriter<T>(
    fn: (connection: DbConnection) => Promise<T>,
    timeoutMs: number = Number.POSITIVE_INFINITY,
  ): Promise<T> {
    const run = this.#writeLock.then(async () => {
      this.#writer ??= await (await this.#getInstance()).connect();
      const writer = this.#writer;
      const timed = runWithTimeout(writer, timeoutMs, fn);
      void timed.finished.then((failure) => {
        if (isFatalDuckDBError(failure)) this.#invalidate();
      });
      try {
        return await timed.value;
      } catch (error) {
        if (isFatalDuckDBError(error)) throw new DatabaseInvalidatedError(error);
        throw error;
      }
    });
    // Keep the chain alive even when this writer rejects, so the next one still runs.
    this.#writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Close every connection and the instance. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const instance = this.#instance;
    this.#instance = undefined;
    for (const waiter of this.#waiting.splice(0)) {
      waiter.settle();
      waiter.reject(new PoolBusyError(`database ${this.path} is closing`));
    }
    for (const connection of this.#idle.splice(0)) connection.closeSync();
    this.#writer?.closeSync();
    this.#writer = undefined;
    this.#open = 0;
    if (instance !== undefined) (await instance).closeSync();
  }
}

let defaultDb: Db | undefined;

/** The process-wide database on {@link DUCKDB_PATH}, created on first use. */
export function getDb(): Db {
  defaultDb ??= new Db(DUCKDB_PATH);
  return defaultDb;
}

/** Close the process-wide database, if one was opened. Used by shutdown and tests. */
export async function closeDb(): Promise<void> {
  const db = defaultDb;
  defaultDb = undefined;
  await db?.close();
}
