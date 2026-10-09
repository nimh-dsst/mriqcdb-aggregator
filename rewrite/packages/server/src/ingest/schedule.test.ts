/**
 * The nightly schedule: when it fires, that it says when it will, and that a
 * failed run does not take it with it.
 *
 * `setTimeout` is injected rather than faked globally, so the test never has to
 * advance a clock the DuckDB binding also reads.
 */

import { describe, expect, it, vi } from 'vitest';
import { msUntilNextRun, nextRunAt, startIngestSchedule, RETRY_DELAY_MS } from './schedule.js';
import type { IngestResult } from './ingest.js';

/** An `IngestResult` with nothing in it, for a stubbed run. */
function emptyResult(dataVersion = 'v1'): IngestResult {
  return {
    source: 'dumps',
    dryRun: false,
    units: [],
    recomputed: [],
    canonicalBefore: {},
    canonicalAfter: {},
    previousDataVersion: dataVersion,
    dataVersion,
    snapshot: null,
    prunedSnapshots: [],
    elapsedMs: 1,
  };
}

/** Collect the delays a schedule asks for, and let the test fire them by hand. */
function fakeTimers(): {
  timers: NonNullable<NonNullable<Parameters<typeof startIngestSchedule>[0]>['timers']>;
  delays: number[];
  fire(): void;
  cleared: number;
} {
  const delays: number[] = [];
  let handler: (() => void) | null = null;
  const state = {
    delays,
    cleared: 0,
    timers: {
      set(next: () => void, ms: number): unknown {
        delays.push(ms);
        handler = next;
        return delays.length;
      },
      clear(): void {
        state.cleared += 1;
        handler = null;
      },
    },
    fire(): void {
      const next = handler;
      handler = null;
      next?.();
    },
  };
  return state;
}

describe('nextRunAt', () => {
  it('is today at the hour when that is still ahead', () => {
    const now = new Date(2026, 9, 8, 1, 30, 0);
    const next = nextRunAt(3, now);
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it('is tomorrow at the hour once it has passed', () => {
    const next = nextRunAt(3, new Date(2026, 9, 8, 3, 0, 0));
    expect(next.getDate()).toBe(9);
    expect(next.getHours()).toBe(3);
  });

  it('crosses a month boundary', () => {
    const next = nextRunAt(3, new Date(2026, 9, 31, 12, 0, 0));
    expect(next.getMonth()).toBe(10);
    expect(next.getDate()).toBe(1);
  });

  it('counts whole milliseconds until then, never zero', () => {
    const now = new Date(2026, 9, 8, 2, 0, 0);
    expect(msUntilNextRun(3, now)).toBe(60 * 60 * 1000);
    expect(msUntilNextRun(2, now)).toBeGreaterThan(0);
  });
});

describe('startIngestSchedule', () => {
  it('stays off unless it is turned on, and says so', () => {
    const logged: string[] = [];
    expect(startIngestSchedule({ log: (m) => logged.push(m) })).toBeNull();
    expect(logged.join('\n')).toMatch(/INGEST_ENABLED=1/);
  });

  it('logs the next run and fires the ingest at it', async () => {
    const timers = fakeTimers();
    const run = vi.fn(async () => emptyResult());
    const logged: string[] = [];
    const schedule = startIngestSchedule({
      force: true,
      hour: 3,
      run,
      timers: timers.timers,
      snapshotDir: null,
      log: (message) => logged.push(message),
    });
    expect(schedule).not.toBeNull();
    expect(timers.delays).toHaveLength(1);
    expect(logged.join('\n')).toMatch(/next run \d{4}-/);
    expect(schedule?.nextRun).toBeInstanceOf(Date);

    timers.fire();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // The run reschedules itself for the following night.
    await vi.waitFor(() => expect(timers.delays).toHaveLength(2));
    expect(logged.join('\n')).toMatch(/data_version v1/);
    schedule?.stop();
    expect(timers.cleared).toBe(1);
  });

  it('reschedules after a failure rather than dying', async () => {
    const timers = fakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error('no dump directory');
    });
    const schedule = startIngestSchedule({
      force: true,
      hour: 3,
      run,
      timers: timers.timers,
      log: () => undefined,
    });
    timers.fire();
    await vi.waitFor(() => expect(timers.delays).toHaveLength(2));
    expect(timers.delays[1]).toBeLessThanOrEqual(RETRY_DELAY_MS);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    schedule?.stop();
  });

  it('stops being able to fire once stopped', async () => {
    const timers = fakeTimers();
    const run = vi.fn(async () => emptyResult());
    const schedule = startIngestSchedule({
      force: true,
      hour: 3,
      run,
      timers: timers.timers,
      log: () => undefined,
    });
    schedule?.stop();
    schedule?.stop();
    expect(timers.cleared).toBe(1);
    timers.fire();
    expect(run).not.toHaveBeenCalled();
  });
});
