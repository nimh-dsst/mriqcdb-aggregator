/**
 * The read pool: timeouts that actually land, a bounded wait queue that honours
 * abort, an instance that can be reopened, and a connection that is dropped rather
 * than re-pooled after a fatal error.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { DUCKDB_MEMORY_LIMIT, DUCKDB_TEMP_DIR, DUCKDB_THREADS } from '../config.js';
import {
  DatabaseInvalidatedError,
  Db,
  PoolBusyError,
  QueryAbortedError,
  QueryTimeoutError,
  isFatalDuckDBError,
} from './instance.js';

/** A cross join big enough that no machine finishes it inside a test. */
const SLOW_QUERY =
  'SELECT count(*) FROM range(100000) a, range(100000) b WHERE (a.range + b.range) % 1000003 = 0';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await tick(5);
  }
}

const open: Db[] = [];

function openDb(path = ':memory:', poolSize = 1, queueLimit?: number): Db {
  const db = queueLimit === undefined ? new Db(path, poolSize) : new Db(path, poolSize, queueLimit);
  open.push(db);
  return db;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) await db.close();
});

describe('instance settings', () => {
  it('applies global settings to two readers and the writer before use', async () => {
    const db = openDb(':memory:', 2);
    const sql = `SELECT current_setting('memory_limit') AS memory,
      current_setting('threads') AS threads, current_setting('temp_directory') AS temp`;
    const control = await DuckDBInstance.create(':memory:');
    const connection = await control.connect();
    let expected: unknown;
    try {
      await connection.run('SET memory_limit = ?', [DUCKDB_MEMORY_LIMIT]);
      expected = (await connection.runAndReadAll(sql)).getRowObjectsJS()[0]?.['memory'];
    } finally {
      connection.closeSync();
      control.closeSync();
    }
    const results = await Promise.all([
      db.withRead((c) => c.all(sql)),
      db.withRead((c) => c.all(sql)),
      db.withWriter((c) => c.all(sql)),
    ]);
    for (const rows of results) {
      expect(rows[0]).toEqual({ memory: expected, threads: BigInt(DUCKDB_THREADS), temp: DUCKDB_TEMP_DIR });
    }
    expect(existsSync(DUCKDB_TEMP_DIR)).toBe(true);
  });
});

describe('query timeout', () => {
  it('interrupts a slow query and leaves the pooled connection usable', async () => {
    const db = openDb(':memory:', 1);
    const started = Date.now();

    await expect(db.withRead((c) => c.all(SLOW_QUERY), 200)).rejects.toBeInstanceOf(
      QueryTimeoutError,
    );
    // The point of the fix: the caller hears about the timeout even when the
    // interrupt is swallowed by a phase that resets DuckDB's interrupt flag.
    expect(Date.now() - started).toBeLessThan(2000);

    // Pool size is 1, so this can only run once the timed-out statement really
    // ended and its connection came back.
    const rows = await db.withRead((c) => c.all('SELECT 42 AS answer'), 10_000);
    expect(Number(rows[0]?.['answer'])).toBe(42);
  }, 30_000);

  it('does not report an ordinary query error as a timeout', async () => {
    const db = openDb();
    await expect(db.withRead((c) => c.all('SELECT * FROM no_such_table'), 10_000)).rejects.not.toBeInstanceOf(
      QueryTimeoutError,
    );
  });
});

describe('wait queue', () => {
  it('removes an aborted waiter instead of letting it acquire a connection later', async () => {
    const db = openDb(':memory:', 1);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const busy = db.withRead(async (c) => {
      await c.all('SELECT 1');
      await held;
    }, 20_000);
    await until(() => db.openConnections === 1);

    const controller = new AbortController();
    let ran = false;
    const queued = db.withRead(
      async (c) => {
        ran = true;
        return c.all('SELECT 2');
      },
      { signal: controller.signal, timeoutMs: 20_000 },
    );
    await until(() => db.waiting === 1);

    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(QueryAbortedError);
    expect(db.waiting).toBe(0);

    release();
    await busy;
    await tick(10);
    // The waiter was removed, so releasing the connection did not hand it over.
    expect(ran).toBe(false);
  }, 30_000);

  it('refuses past the queue limit rather than parking an unbounded crowd', async () => {
    const db = openDb(':memory:', 1, 2);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = db.withRead(async (c) => {
      await c.all('SELECT 1');
      await held;
    }, 20_000);
    await until(() => db.openConnections === 1);

    const parked = [
      db.withRead((c) => c.all('SELECT 2'), 20_000),
      db.withRead((c) => c.all('SELECT 3'), 20_000),
    ];
    await until(() => db.waiting === 2);
    await expect(db.withRead((c) => c.all('SELECT 4'), 20_000)).rejects.toBeInstanceOf(PoolBusyError);

    release();
    await busy;
    await Promise.all(parked);
  }, 30_000);

  it('rejects a waiter that outlives its own budget', async () => {
    const db = openDb(':memory:', 1);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = db.withRead(async (c) => {
      await c.all('SELECT 1');
      await held;
    }, 20_000);
    await until(() => db.openConnections === 1);

    await expect(db.withRead((c) => c.all('SELECT 2'), 150)).rejects.toBeInstanceOf(PoolBusyError);

    release();
    await busy;
  }, 30_000);
});

describe('instance lifecycle', () => {
  it('retries after a failed open instead of caching the rejection forever', async () => {
    const create = vi.spyOn(DuckDBInstance, 'create');
    create.mockRejectedValueOnce(new Error('IO Error: file is locked'));

    const db = openDb();
    await expect(db.withRead((c) => c.all('SELECT 1'))).rejects.toThrow(/locked/);

    const rows = await db.withRead((c) => c.all('SELECT 1 AS one'));
    expect(Number(rows[0]?.['one'])).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('reopens the instance after a fatal error rather than serving it forever', async () => {
    const db = openDb(':memory:', 2);
    await db.withRead((c) => c.all('SELECT 1'));
    expect(db.openConnections).toBe(1);

    await expect(
      db.withRead(() => {
        throw new Error('FATAL Error: Failed: database has been invalidated');
      }),
    ).rejects.toBeInstanceOf(DatabaseInvalidatedError);
    await until(() => db.openConnections === 0);

    const rows = await db.withRead((c) => c.all('SELECT 7 AS v'));
    expect(Number(rows[0]?.['v'])).toBe(7);
  }, 30_000);

  it('knows a fatal error from an ordinary one', () => {
    expect(isFatalDuckDBError(new Error('database has been invalidated'))).toBe(true);
    expect(isFatalDuckDBError(new Error('FATAL Error: out of disk'))).toBe(true);
    expect(isFatalDuckDBError(new Error('Catalog Error: no such table'))).toBe(false);
    expect(isFatalDuckDBError(undefined)).toBe(false);
  });
});
