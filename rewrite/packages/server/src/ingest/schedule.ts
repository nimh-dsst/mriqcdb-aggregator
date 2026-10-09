/**
 * The nightly in-process ingest.
 *
 * See `docs/backend-graph.md`, "Ingest from dumps (decided 2026-10-08)": the same
 * function the CLI runs, on a timer, at `INGEST_HOUR` (default 03:00 local) and
 * only when `INGEST_ENABLED=1`. It is off in development, which is why a
 * developer's `pnpm start` never touches the dump directory.
 *
 * A timer rather than cron inside the process because ingest takes the writer
 * mutex, and the writer belongs to the server process: a second process opening
 * the same DuckDB file for writing is what DuckDB refuses. `index.ts` starts it
 * and the shutdown path stops it.
 */

import { INGEST_ENABLED, INGEST_HOUR } from '../config.js';
import { getDb, type Db } from '../db/instance.js';
import { ingest, type IngestOptions, type IngestResult } from './ingest.js';

/** How long after a failed run the next one is attempted, rather than waiting a day. */
export const RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * The next local-time occurrence of `hour`, strictly after `now`.
 *
 * Built from the calendar date rather than by adding a fixed offset, so a run
 * stays at 03:00 across a daylight-saving boundary instead of drifting to 02:00
 * or 04:00 for half the year.
 */
export function nextRunAt(hour: number, now: Date = new Date()): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Milliseconds until the next run, at least one so a timer always fires later. */
export function msUntilNextRun(hour: number, now: Date = new Date()): number {
  return Math.max(1, nextRunAt(hour, now).getTime() - now.getTime());
}

/** A running schedule. */
export interface IngestSchedule {
  /** When the next run is due. */
  readonly nextRun: Date;
  /** Cancel the pending timer. Safe to call more than once. */
  stop(): void;
}

/** Options for {@link startIngestSchedule}. */
export interface ScheduleOptions extends IngestOptions {
  /** Local hour to run at; `INGEST_HOUR` by default. */
  hour?: number;
  /** Run even when `INGEST_ENABLED` is not `1`. Used by the tests. */
  force?: boolean;
  /** Replaces the call to {@link ingest}, for the tests. */
  run?: (options: IngestOptions) => Promise<IngestResult>;
  /** Replaces `setTimeout`/`clearTimeout`, for the tests. */
  timers?: {
    set(handler: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

/**
 * Start the nightly schedule, or return null when it is switched off.
 *
 * Returning null rather than a dormant schedule is deliberate: the caller logs
 * what it got, so a server that is *not* going to ingest says so at startup
 * instead of looking as though it will.
 */
export function startIngestSchedule(options: ScheduleOptions = {}): IngestSchedule | null {
  const enabled = options.force === true || INGEST_ENABLED;
  const log = options.log ?? ((message: string) => console.log(message));
  if (!enabled) {
    log('[ingest] nightly schedule off (set INGEST_ENABLED=1 to turn it on)');
    return null;
  }

  const hour = options.hour ?? INGEST_HOUR;
  const run = options.run ?? ingest;
  const db: Db = options.db ?? getDb();
  const timers =
    options.timers ??
    ({
      set: (handler, ms) => {
        const handle = setTimeout(handler, ms);
        // A pending nightly timer must not be what keeps the process alive.
        handle.unref?.();
        return handle;
      },
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
    } satisfies NonNullable<ScheduleOptions['timers']>);

  let handle: unknown = null;
  let stopped = false;
  let nextRun = nextRunAt(hour);

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    nextRun = new Date(Date.now() + delayMs);
    log(`[ingest] next run ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);
    handle = timers.set(() => {
      void fire();
    }, delayMs);
  };

  const fire = async (): Promise<void> => {
    try {
      const result = await run({ ...options, db, log });
      log(
        `[ingest] ${result.units.length} unit(s), data_version ${result.dataVersion}` +
          `${result.snapshot === null ? '' : `, snapshot ${result.snapshot}`}`,
      );
      schedule(msUntilNextRun(hour));
    } catch (error: unknown) {
      // A failed nightly run must not take the schedule with it: the dump
      // directory may simply not have been written yet.
      console.error('[ingest]', error);
      schedule(Math.min(RETRY_DELAY_MS, msUntilNextRun(hour)));
    }
  };

  schedule(msUntilNextRun(hour));
  return {
    get nextRun(): Date {
      return nextRun;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
  };
}
