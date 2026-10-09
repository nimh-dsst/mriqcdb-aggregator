/** Threadpool sizing, which is pure arithmetic once the side effect is split out. */

import { describe, expect, it } from 'vitest';
import { UV_THREADPOOL_DEFAULT, chooseThreadpoolSize } from './bootstrap.js';
import { poolSizeFor } from './config.js';

describe('chooseThreadpoolSize', () => {
  it('leaves headroom above the read pool when nothing is set', () => {
    expect(chooseThreadpoolSize(16, undefined)).toBe(20);
    expect(chooseThreadpoolSize(2, '')).toBe(6);
    expect(chooseThreadpoolSize(1, '   ')).toBe(5);
    // Never below what libuv would have given us anyway.
    expect(chooseThreadpoolSize(0, undefined)).toBe(UV_THREADPOOL_DEFAULT);
  });

  it('never overrides what the environment already fixed', () => {
    // libuv has already read whatever the environment said; nothing we assign
    // afterwards can change the pool it built.
    expect(chooseThreadpoolSize(16, '8')).toBe(8);
    expect(chooseThreadpoolSize(2, '64')).toBe(64);
  });

  it('ignores an unusable value', () => {
    expect(chooseThreadpoolSize(4, 'lots')).toBe(8);
    expect(chooseThreadpoolSize(4, '0')).toBe(8);
    expect(chooseThreadpoolSize(4, '-2')).toBe(8);
  });
});

describe('poolSizeFor', () => {
  it('keeps two threads clear of the read pool', () => {
    expect(poolSizeFor(16, 8)).toBe(6);
    expect(poolSizeFor(16, null)).toBe(16);
    expect(poolSizeFor(2, 64)).toBe(2);
    expect(poolSizeFor(8, 2)).toBe(1);
  });

  it('agrees with the size bootstrap would choose', () => {
    for (const requested of [1, 2, 4, 8, 16, 64]) {
      const threadpool = chooseThreadpoolSize(requested, undefined);
      expect(poolSizeFor(requested, threadpool)).toBe(requested);
    }
  });
});
