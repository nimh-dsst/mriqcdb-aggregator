/**
 * The completed catalog's cache.
 *
 * The catalog is the first request of every dashboard load, so the thing worth
 * asserting is not what it contains -- the router tests do that -- but that a
 * burst of concurrent misses computes it once.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RAW_ROWS, isNullManufacturer, makeFixture, type Fixture } from '../testing/fixture.js';
import { getCompletedCatalog, invalidateCatalog } from './complete.js';

let dir: string;
let fixture: Fixture;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-catalog-'));
  fixture = await makeFixture(dir);
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('getCompletedCatalog', () => {
  it('computes once for a burst of concurrent cold-cache callers', async () => {
    invalidateCatalog(fixture.db);
    // Every scan of the computation goes through `withRead`, so counting those
    // counts how many times the catalog was built.
    const reads = vi.spyOn(fixture.db, 'withRead');

    const results = await Promise.all(
      Array.from({ length: 12 }, () => getCompletedCatalog(fixture.db)),
    );

    // One shared promise, so one shared result object.
    expect(new Set(results).size).toBe(1);
    const readsForOneComputation = reads.mock.calls.length;
    expect(readsForOneComputation).toBeGreaterThan(5);

    // And a hit costs nothing at all, not even a `meta` round trip.
    reads.mockClear();
    const hit = await getCompletedCatalog(fixture.db);
    expect(hit).toBe(results[0]);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  }, 120_000);

  it('recomputes after the cache is invalidated', async () => {
    const before = await getCompletedCatalog(fixture.db);
    invalidateCatalog(fixture.db);
    const after = await getCompletedCatalog(fixture.db);
    expect(after).not.toBe(before);
    expect(after.dataVersion).toBe(before.dataVersion);
  }, 120_000);

  it('reports null and empty manufacturers as one unlabelled bucket', async () => {
    const catalog = await getCompletedCatalog(fixture.db);
    const values = catalog.fieldValues['manufacturer']?.['bold']?.['raw'] ?? [];

    // One bucket for "no value", not one per way of having none, and nothing
    // that would render as a blank option beside it.
    const none = values.filter((entry) => entry.value === null || entry.value === '');
    expect(none).toHaveLength(1);
    expect(none[0]?.value).toBeNull();

    const expected = Array.from({ length: RAW_ROWS }, (_, i) => i).filter(isNullManufacturer);
    expect(none[0]?.n).toBe(expected.length);

    // Still ordered by count, which is the list's contract.
    const counts = values.map((entry) => entry.n);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  }, 120_000);

  it('bounds every numeric filterable field, canonical-only ones included', async () => {
    const catalog = await getCompletedCatalog(fixture.db);

    // The fixture's `canonical_diameter` is `i * 0.01` over the even rows, and
    // `canonical_group_rows` is `2 + i % 3`, so these are the real extremes of
    // the column rather than a placeholder.
    const diameter = catalog.numericRange['canonical_diameter']?.['bold']?.['k4plus'];
    expect(diameter?.min).toBe(0);
    expect(diameter?.max).toBeCloseTo((RAW_ROWS - 2) * 0.01, 6);
    expect(catalog.numericRange['canonical_group_rows']?.['bold']?.['k4plus']).toEqual({
      min: 2,
      max: 4,
    });
    expect(catalog.numericRange['canonical_diameter']?.['T1w']?.['k3pp']).toBeDefined();

    // Canonical-only means no entry on the raw log, and the ordinary numeric
    // fields are bounded on both views.
    expect(catalog.numericRange['canonical_diameter']?.['bold']?.['raw']).toBeUndefined();
    expect(catalog.numericRange['echo_time']?.['bold']?.['raw']).toEqual({ min: 0.03, max: 0.034 });
    expect(catalog.numericRange['echo_time']?.['bold']?.['k4plus']).toBeDefined();

    // A categorical field has a value list, not a range.
    expect(catalog.numericRange['manufacturer']).toBeUndefined();
  }, 120_000);

  it('does not cache a failed computation', async () => {
    invalidateCatalog(fixture.db);
    const reads = vi.spyOn(fixture.db, 'withRead');
    reads.mockRejectedValueOnce(new Error('transient'));

    await expect(getCompletedCatalog(fixture.db)).rejects.toThrow('transient');
    reads.mockRestore();

    await expect(getCompletedCatalog(fixture.db)).resolves.toMatchObject({
      dataVersion: fixture.result.dataVersion,
    });
  }, 120_000);
});
