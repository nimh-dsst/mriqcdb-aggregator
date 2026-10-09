import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInfRow, isNaNRow, isNullRow, makeFixture, type Fixture } from '../testing/fixture.js';
import { createCaller } from './router.js';

let dir: string;
let fixture: Fixture;
let caller: ReturnType<typeof createCaller>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-selections-'));
  fixture = await makeFixture(dir);
  caller = createCaller({ db: fixture.db });
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Range = { metric: string; range: [number, number] };
type Scope = { selections?: Range[]; selection?: Range | null };
const first: Range = { metric: 'fd_mean', range: [10, 40] };
const second: Range = { metric: 'efc', range: [2, 6] };
const input = { modality: 'bold' as const, view: 'raw' as const };
const procedures = ['distribution', 'groupedSummary', 'coverage', 'sample', 'density2d', 'correlation', 'timeSummary'] as const;
async function count(proc: typeof procedures[number], ranges: Scope): Promise<number> {
  const scope = { ...input, ...ranges };
  switch (proc) {
    case 'distribution': return (await caller.distribution({ ...scope, metric: 'fd_mean' })).n;
    case 'groupedSummary': {
      const result = await caller.groupedSummary({ ...scope, metric: 'fd_mean', group: 'manufacturer' });
      return result.groups.reduce((n, g) => n + g.n, result.other?.n ?? 0);
    }
    case 'coverage': return (await caller.coverage({ ...scope, group: 'manufacturer', granularity: 'month' })).buckets.reduce((n, b) => n + b.n, 0);
    case 'sample': return (await caller.sample({ ...scope, columns: ['fd_mean', 'efc'], limit: 500 })).rows.length;
    case 'density2d': return (await caller.density2d({ ...scope, x: 'fd_mean', y: 'efc', sampleSize: 0 })).n;
    case 'correlation': return (await caller.correlation({ ...scope, metrics: ['fd_mean', 'efc'], method: 'pearson' })).pairN[0]![1]!;
    case 'timeSummary': return (await caller.timeSummary({ ...scope, metric: 'fd_mean', granularity: 'month' })).buckets.reduce((n, b) => n + b.n, 0);
  }
}
const kept = Array.from({ length: 61 }, (_, i) => i + 20).filter(i => !isNaNRow(i) && !isInfRow(i) && !isNullRow(i));

describe.each(procedures)('%s selections', proc => {
  it('accepts empty, legacy, single and two-range forms with AND semantics', async () => {
    expect(await count(proc, { selections: [] })).toBe(await count(proc, { selection: null }));
    expect(await count(proc, { selection: first })).toBe(kept.length);
    expect(await count(proc, { selections: [first] })).toBe(kept.length);
    expect(await count(proc, { selections: [first, second] })).toBe(kept.filter(i => i % 13 >= 2 && i % 13 <= 5).length);
    expect(await count(proc, { selections: [second, first] })).toBe(await count(proc, { selections: [first, second] }));
  });

  it.each([
    { selections: [first, first] },
    { selections: ['fd_mean', 'efc', 'fber', 'fwhm_x', 'fwhm_y'].map(metric => ({ metric, range: [0, 1] as [number, number] })) },
    { selections: [], selection: first },
    { selections: [{ metric: 'fd_mean', range: [1, 0] as [number, number] }] },
  ])('refuses invalid ranges %j', async ranges => {
    await expect(count(proc, ranges)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

it('accepts the maximum four distinct metric selections', async () => {
  expect(await count('sample', { selections: [first, second,
    { metric: 'fber', range: [0, 100] }, { metric: 'fwhm_x', range: [0, 100] }] })).toBe(
    kept.filter(i => i % 13 >= 2 && i % 13 <= 5).length);
});
