import { describe, expect, it } from 'vitest';
import { compile } from 'vega-lite';
import { coverageSpec } from './coverage';

describe('time marks', () => {
  it.each(['bars', 'line', 'area'] as const)('compiles %s', form => {
    expect(() => compile(coverageSpec(form, '', 'month', 'Scans'))).not.toThrow();
  });
  it('normalizes Area with series and leaves single-series Area as counts', () => {
    const multiple = coverageSpec('area', '', 'month', 'Scans', undefined, ['A', 'B']);
    const single = coverageSpec('area', '', 'month', 'Scans', undefined, ['A']);
    expect(multiple).toMatchObject({ encoding: { y: { stack: 'normalize', axis: { format: '.0%' } } } });
    expect(single).toMatchObject({ encoding: { y: { stack: 'zero', title: 'Scans' } } });
  });
});
