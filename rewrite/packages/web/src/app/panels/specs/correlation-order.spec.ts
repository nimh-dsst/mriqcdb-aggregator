import { correlationOrder } from './correlation-order';

describe('correlationOrder', () => {
  it('keeps strongly correlated dimensions adjacent using average linkage', () => {
    const matrix = [
      [1, 0.9, 0.1, 0.1],
      [0.9, 1, 0.2, 0.2],
      [0.1, 0.2, 1, 0.8],
      [0.1, 0.2, 0.8, 1],
    ];

    expect(correlationOrder(matrix)).toEqual([0, 1, 2, 3]);
  });

  it('uses a deterministic maximum-distance fallback for missing values', () => {
    const matrix = [
      [1, null, 0.8],
      [null, 1, 0.2],
      [0.8, 0.2, 1],
    ];

    expect(correlationOrder(matrix)).toEqual([0, 2, 1]);
  });

  it('treats non-finite runtime values as missing and preserves every dimension', () => {
    const matrix = [
      [1, Number.NaN, 0],
      [Number.NaN, 1, Number.POSITIVE_INFINITY],
      [0, Number.POSITIVE_INFINITY, 1],
    ];

    expect(correlationOrder(matrix)).toEqual([0, 1, 2]);
  });
});
