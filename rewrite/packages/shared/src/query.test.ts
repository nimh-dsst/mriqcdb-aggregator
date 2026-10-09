import { describe, expect, it } from 'vitest';
import { queryKey, type Query, type BinnedSummaryQuery } from './query.js';
import { asColumnId, type Filter, type Selection } from './types.js';

const metric = asColumnId('fd_mean');
const manufacturer = asColumnId('manufacturer');
const echoTime = asColumnId('echo_time');
const createdAt = asColumnId('created_at');

function distribution(overrides: Partial<Extract<Query, { proc: 'distribution' }>> = {}): Query {
  return {
    source: 'population',
    proc: 'distribution',
    modality: 'bold',
    view: 'k4plus',
    filters: [],
    metric,
    bins: 64,
    clip: 'p01p99',
    ...overrides,
  };
}

describe('queryKey', () => {
  it('sorts selections by metric without mutating the input and normalizes the alias', () => {
    const a: Selection = { metric, range: [0, 1] };
    const b: Selection = { metric: asColumnId('efc'), range: [2, 3] };
    const selections = [a, b];
    expect(queryKey(distribution({ selections }))).toBe(queryKey(distribution({ selections: [b, a] })));
    expect(selections).toEqual([a, b]);
    expect(queryKey(distribution({ selections: [a] }))).toBe(queryKey(distribution({ selection: a })));
    expect(queryKey(distribution({ selections: [] }))).toBe(queryKey(distribution()));
    expect(queryKey(distribution({ selections }))).not.toBe(queryKey(distribution({ selections: [a] })));
  });

  it('rejects duplicate selections and conflicting forms', () => {
    const selection: Selection = { metric, range: [0, 1] };
    expect(() => queryKey(distribution({ selections: [selection, selection] }))).toThrow(/distinct/);
    expect(() => queryKey(distribution({ selections: [], selection }))).toThrow(/not both/);
  });

  it('keys every time summary parameter including study scope', () => {
    const query: BinnedSummaryQuery = { source: 'population', proc: 'binnedSummary',
      modality: 'bold', view: 'raw', filters: [], x: 'created_at', y: metric, bins: 'month' };
    const key = queryKey(query);
    for (const change of [{ bins: 'day' as const }, { groups: manufacturer },
      { source: 'study' as const }, { range: [7305, 7365] as [number, number] }, { x: metric, bins: 10 }, { y: asColumnId('efc') }, { cohorts: [{ id: 'a', filters: [] }] },
      { selections: [{ metric, range: [1, 2] as [number, number] }] }]) {
      expect(queryKey({ ...query, ...change })).not.toBe(key);
    }
  });
  it('is independent of property order', () => {
    const a: Query = {
      source: 'population',
      proc: 'distribution',
      modality: 'bold',
      view: 'k4plus',
      filters: [],
      metric,
      bins: 64,
      clip: 'p01p99',
    };
    const b: Query = {
      clip: 'p01p99',
      bins: 64,
      metric,
      filters: [],
      view: 'k4plus',
      modality: 'bold',
      proc: 'distribution',
      source: 'population',
    };
    expect(queryKey(a)).toBe(queryKey(b));
  });

  it('is independent of filter order and of value order inside an `in`', () => {
    const one: readonly Filter[] = [
      { field: manufacturer, op: 'in', values: ['Siemens', 'GE', 'Philips'] },
      { field: echoTime, op: 'between', lo: 0.01, hi: 0.05 },
      { field: createdAt, op: 'notNull' },
    ];
    const other: readonly Filter[] = [
      { field: createdAt, op: 'notNull' },
      { field: echoTime, op: 'between', lo: 0.01, hi: 0.05 },
      { field: manufacturer, op: 'in', values: ['Philips', 'Siemens', 'GE'] },
    ];
    expect(queryKey(distribution({ filters: one }))).toBe(
      queryKey(distribution({ filters: other })),
    );
  });

  it('treats an absent selection and a null selection alike', () => {
    expect(queryKey(distribution({ selection: null }))).toBe(queryKey(distribution()));
  });

  it('separates different bin counts', () => {
    expect(queryKey(distribution({ bins: 64 }))).not.toBe(queryKey(distribution({ bins: 65 })));
  });

  it('separates clip modes, because the server bins over the clipped range', () => {
    const base = queryKey(distribution());
    expect(queryKey(distribution({ clip: 'p05p95' }))).not.toBe(base);
    expect(queryKey(distribution({ clip: 'none' }))).not.toBe(base);
    expect(queryKey(distribution({ clip: 'none' }))).not.toBe(
      queryKey(distribution({ clip: 'p05p95' })),
    );
    expect(base).toContain('clip=p01p99');
  });

  it('separates an explicit histogram range, and omits it when there is none', () => {
    const base = queryKey(distribution());
    expect(base).not.toContain('range=');
    const shared = queryKey(distribution({ range: [0, 1] }));
    expect(shared).toContain('range=0..1');
    expect(shared).not.toBe(base);
    // The comparison panel refetches when the shared range moves, which is only
    // true if the moved range is a different key.
    expect(queryKey(distribution({ range: [0, 1.5] }))).not.toBe(shared);
    // Two cohorts of one panel differ in their filters, not in their range.
    expect(queryKey(distribution({ range: [0, 1] }))).toBe(shared);
  });

  it('separates every parameter that changes the result', () => {
    const base = queryKey(distribution());
    expect(queryKey(distribution({ modality: 'T1w', view: 'raw' }))).not.toBe(base);
    expect(queryKey(distribution({ view: 'raw' }))).not.toBe(base);
    expect(queryKey(distribution({ metric: asColumnId('tsnr') }))).not.toBe(base);
    expect(queryKey(distribution({ source: 'study' }))).not.toBe(base);
    expect(
      queryKey(distribution({ selection: { metric, range: [0, 1] } })),
    ).not.toBe(base);
    expect(
      queryKey(distribution({ selection: { metric, range: [0, 1] } })),
    ).not.toBe(queryKey(distribution({ selection: { metric, range: [0, 2] } })));
    expect(
      queryKey(distribution({ filters: [{ field: manufacturer, op: 'isNull' }] })),
    ).not.toBe(queryKey(distribution({ filters: [{ field: manufacturer, op: 'notNull' }] })));
  });

  it('does not confuse a string value with the number that prints the same', () => {
    const asNumber = distribution({
      filters: [{ field: manufacturer, op: 'in', values: [3] }],
    });
    const asString = distribution({
      filters: [{ field: manufacturer, op: 'in', values: ['3'] }],
    });
    expect(queryKey(asNumber)).not.toBe(queryKey(asString));
  });

  it('formats numbers stably, including negative zero', () => {
    expect(queryKey(distribution({ selection: { metric, range: [-0, 1] } }))).toBe(
      queryKey(distribution({ selection: { metric, range: [0, 1] } })),
    );
    expect(queryKey(distribution({ bins: 64 }))).toContain('bins=64');
  });

  it('keys the other procedures', () => {
    expect(
      queryKey({
        source: 'population',
        proc: 'coverage',
        modality: 'T1w',
        view: 'k3pp',
        filters: [],
        group: manufacturer,
        granularity: 'month',
      }),
    ).toBe('population/coverage?gran=month&group=manufacturer&m=T1w&v=k3pp');

    expect(queryKey({ source: 'population', proc: 'catalog' })).toBe('population/catalog');

    const sample: Query = {
      source: 'population',
      proc: 'sample',
      modality: 'T2w',
      view: 'raw',
      filters: [],
      columns: [asColumnId('id'), asColumnId('cjv')],
      cursor: null,
    };
    expect(queryKey(sample)).toBe('population/sample?cols=id,cjv&m=T2w&v=raw');
    expect(queryKey({ ...sample, cursor: '2020-01-01|abc' })).not.toBe(queryKey(sample));
  });

  it('keys density2d ranges, sample size, and the default seed', () => {
    const base: Extract<Query, { proc: 'density2d' }> = {
      source: 'study',
      proc: 'density2d',
      modality: 'bold',
      view: 'k4plus',
      filters: [],
      x: asColumnId('fd_mean'),
      y: asColumnId('tsnr'),
      bins: 32,
      clip: 'p01p99',
      range: { x: [0, 1], y: [10, 20] },
      sampleSize: 500,
    };
    const implicitSeed = queryKey(base);
    expect(implicitSeed).toContain('range=x:0..1;y:10..20');
    expect(implicitSeed).toContain('sampleSize=500');
    expect(implicitSeed).toContain('seed=1');
    expect(queryKey({ ...base, seed: 1 })).toBe(implicitSeed);
    expect(queryKey({ ...base, seed: 2 })).not.toBe(implicitSeed);
    expect(queryKey({ ...base, sampleSize: 501 })).not.toBe(implicitSeed);
    expect(queryKey({ ...base, range: { x: [0, 2], y: [10, 20] } })).not.toBe(implicitSeed);
    expect(queryKey({ ...base, range: { x: [0, 1], y: [11, 20] } })).not.toBe(implicitSeed);
    const { range: _range, ...withoutRange } = base;
    expect(queryKey(withoutRange)).not.toBe(implicitSeed);
  });

  it('preserves correlation metric order while normalizing shared scope', () => {
    const one: Query = {
      source: 'population',
      proc: 'correlation',
      modality: 'T1w',
      view: 'k3pp',
      filters: [{ field: manufacturer, op: 'in', values: ['GE', 'Siemens'] }],
      metrics: [metric, asColumnId('tsnr'), echoTime],
      method: 'both',
    };
    const sameMeaning: Query = {
      ...one,
      filters: [{ field: manufacturer, op: 'in', values: ['Siemens', 'GE'] }],
    };
    expect(queryKey(one)).toBe(queryKey(sameMeaning));
    expect(queryKey({ ...one, metrics: [asColumnId('tsnr'), metric, echoTime] })).not.toBe(
      queryKey(one),
    );
    expect(queryKey({ ...one, method: 'pearson' })).not.toBe(queryKey(one));
    expect(queryKey({ ...one, source: 'study' })).not.toBe(queryKey(one));
  });

  it('is stable across repeated calls', () => {
    const q = distribution({
      filters: [{ field: manufacturer, op: 'in', values: ['Siemens', 'GE'] }],
      selection: { metric, range: [0.1, 0.9] },
    });
    expect(queryKey(q)).toBe(queryKey(q));
  });
});
