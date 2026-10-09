/**
 * `data_version` as a live value: the source the `dataVersion` subscription reads.
 *
 * See `docs/backend-graph.md`, "Process and concurrency": after a commit, ingest
 * updates `meta.data_version`, invalidates the catalog cache, and emits on an
 * in-process event. The subscription is an async generator over that event. That
 * is the entire mechanism by which the frontend learns to refetch.
 */

import { EventEmitter, on } from 'node:events';
import type { Db } from '../db/instance.js';
import { invalidateCatalog, readMeta } from '../catalog/complete.js';

const CHANGED = 'changed';

/** In-process bus carrying `(db, dataVersion)` on every version change. */
const emitter = new EventEmitter();
// One listener per open subscription; the default cap of 10 would warn on a busy
// dashboard, and an unbounded count here is the intended shape, not a leak.
emitter.setMaxListeners(0);

/** The last version observed for each database, so a reader never has to query. */
const current = new WeakMap<Db, string>();

/** The current `data_version`, reading `meta` only the first time. */
export async function getDataVersion(db: Db): Promise<string> {
  const known = current.get(db);
  if (known !== undefined) return known;
  const { dataVersion } = await readMeta(db);
  current.set(db, dataVersion);
  return dataVersion;
}

/**
 * Record a new `data_version`, drop the cached catalog and wake every subscriber.
 * Ingest calls this after its transaction commits; a no-op when nothing changed.
 */
export function publishDataVersion(db: Db, dataVersion: string): void {
  if (current.get(db) === dataVersion) return;
  current.set(db, dataVersion);
  invalidateCatalog(db);
  emitter.emit(CHANGED, db, dataVersion);
}

/** Re-read `meta` and publish whatever it now says. Used after an out-of-band rebuild. */
export async function refreshDataVersion(db: Db): Promise<string> {
  const { dataVersion } = await readMeta(db);
  publishDataVersion(db, dataVersion);
  return dataVersion;
}

/**
 * The version stream for `db`: the current value immediately, then one value per
 * change. Ends when `signal` aborts, which is what the client disconnecting does.
 */
export async function* dataVersionStream(
  db: Db,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  // The listener is attached *before* the first yield. A generator is suspended at
  // a yield until the transport calls `next()`, so subscribing afterwards would
  // drop every change published in that window -- an EventEmitter has no replay,
  // and the client would stay stale until the following change.
  if (signal?.aborted === true) return;
  const events = on(emitter, CHANGED, signal === undefined ? {} : { signal });
  try {
    let last = await getDataVersion(db);
    yield last;
    for await (const [changedDb, version] of events as AsyncIterable<[Db, string]>) {
      if (changedDb !== db || version === last) continue;
      last = version;
      yield version;
    }
  } catch (error) {
    // An aborted signal is how a subscription ends, not a failure to report.
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  } finally {
    // Nothing else detaches the listener when the first read throws.
    await events.return?.();
  }
}
