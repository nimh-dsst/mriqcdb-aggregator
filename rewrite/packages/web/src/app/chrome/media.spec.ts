import { gridColumns, lastCardSpan } from './media';

describe('gridColumns', () => {
  it('is one column below the first breakpoint', () => {
    expect(gridColumns(false, false)).toBe(1);
  });

  it('is two from 900px', () => {
    expect(gridColumns(true, false)).toBe(2);
  });

  it('is three from 1500px', () => {
    expect(gridColumns(true, true)).toBe(3);
  });
});

describe('lastCardSpan', () => {
  it('leaves a full last row alone', () => {
    expect(lastCardSpan(6, 3)).toBe(1);
    expect(lastCardSpan(4, 2)).toBe(1);
  });

  it('fills the hole the default five panels leave in three columns', () => {
    // Cards 4 and 5 share the last row; the fifth takes the width left over.
    expect(lastCardSpan(5, 3)).toBe(2);
  });

  it('gives a lone last card the whole row', () => {
    expect(lastCardSpan(4, 3)).toBe(3);
    expect(lastCardSpan(1, 3)).toBe(3);
    expect(lastCardSpan(5, 2)).toBe(2);
  });

  it('never spans in a single column, and survives an empty grid', () => {
    expect(lastCardSpan(5, 1)).toBe(1);
    expect(lastCardSpan(0, 3)).toBe(1);
  });
});
