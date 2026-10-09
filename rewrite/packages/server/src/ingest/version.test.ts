/**
 * The `dataVersion` subscription source.
 *
 * `publishDataVersion` seeds the in-process value, so these run against a database
 * handle that is never opened: the stream's contract is about the event bus, not
 * about `meta`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../db/instance.js';
import { dataVersionStream, getDataVersion, publishDataVersion } from './version.js';

const open: Db[] = [];

function handle(): Db {
  const db = new Db(':memory:', 1);
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});

describe('dataVersionStream', () => {
  it('emits the current version first', async () => {
    const db = handle();
    publishDataVersion(db, 'v1');
    const stream = dataVersionStream(db);
    expect((await stream.next()).value).toBe('v1');
    await stream.return(undefined);
  });

  it('receives a change published before the first yield was consumed again', async () => {
    const db = handle();
    publishDataVersion(db, 'v1');
    const stream = dataVersionStream(db);

    // The generator is suspended at its first yield here. The listener has to be
    // attached already, or this change is lost -- an EventEmitter has no replay
    // and the client would stay stale until the next one.
    expect((await stream.next()).value).toBe('v1');
    publishDataVersion(db, 'v2');

    expect((await stream.next()).value).toBe('v2');
    await stream.return(undefined);
  }, 10_000);

  it('ignores changes to another database and repeats of what it already sent', async () => {
    const db = handle();
    const other = handle();
    publishDataVersion(db, 'v1');
    const stream = dataVersionStream(db);
    expect((await stream.next()).value).toBe('v1');

    publishDataVersion(other, 'v-other');
    publishDataVersion(db, 'v2');
    expect((await stream.next()).value).toBe('v2');
    await stream.return(undefined);
  }, 10_000);

  it('ends when the signal aborts', async () => {
    const db = handle();
    publishDataVersion(db, 'v1');
    const controller = new AbortController();
    const stream = dataVersionStream(db, controller.signal);
    expect((await stream.next()).value).toBe('v1');
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  }, 10_000);

  it('serves the published version without reading meta', async () => {
    const db = handle();
    publishDataVersion(db, 'v9');
    await expect(getDataVersion(db)).resolves.toBe('v9');
  });
});
