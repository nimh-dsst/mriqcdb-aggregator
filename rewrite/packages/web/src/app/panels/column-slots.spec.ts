import { describe, expect, it } from 'vitest';

import {
  EMPTY_DRAWER_SLOTS,
  canSwapDrawerSlots,
  reduceDrawerSlots,
  type DrawerSlotColumn,
} from './column-slots';

const continuous = (id: string): DrawerSlotColumn => ({
  id,
  isNumeric: true,
  isContinuous: true,
});

const discrete = (id: string): DrawerSlotColumn => ({
  id,
  isNumeric: false,
  isContinuous: false,
});

describe('drawer slots', () => {
  it('sets the first pick as X and sends subsequent picks to Y', () => {
    const x = continuous('x');
    const y = continuous('y');
    const withX = reduceDrawerSlots(EMPTY_DRAWER_SLOTS, { type: 'pick', column: x });
    const withY = reduceDrawerSlots(withX, { type: 'pick', column: y });

    expect(withX).toMatchObject({ x, y: null, focused: 'y' });
    expect(withY).toMatchObject({ x, y, focused: 'y' });
  });

  it('replaces X with a nonnumeric next pick and clears Y', () => {
    const slots = {
      x: continuous('x'),
      y: continuous('y'),
      focused: 'y' as const,
    };

    expect(reduceDrawerSlots(slots, { type: 'pick', column: discrete('group') }))
      .toMatchObject({ x: discrete('group'), y: null, focused: 'y' });
  });

  it('replaces X when its slot has explicit focus', () => {
    const oldY = continuous('old-y');
    const slots = {
      x: continuous('old-x'),
      y: oldY,
      focused: 'x' as const,
    };
    const nextX = continuous('next-x');

    expect(reduceDrawerSlots(slots, { type: 'pick', column: nextX }))
      .toMatchObject({ x: nextX, y: oldY, focused: 'x' });
  });

  it('only accepts numeric Y values with a continuous X', () => {
    const categoricalX = reduceDrawerSlots(EMPTY_DRAWER_SLOTS, {
      type: 'pick',
      column: discrete('group'),
    });

    expect(reduceDrawerSlots(categoricalX, { type: 'pick', column: continuous('metric') }))
      .toMatchObject({ x: continuous('metric'), y: null });
  });

  it('clears a focused slot and swaps only when X is numeric', () => {
    const x = continuous('x');
    const y = continuous('y');
    const slots = { x, y, focused: 'y' as const };

    expect(canSwapDrawerSlots(slots)).toBe(true);
    expect(reduceDrawerSlots(slots, { type: 'swap' })).toMatchObject({ x: y, y: x });
    expect(reduceDrawerSlots(slots, { type: 'clear', slot: 'y' })).toMatchObject({ x, y: null });
    const cleared = reduceDrawerSlots(slots, { type: 'clear', slot: 'x' });
    expect(cleared).toMatchObject({ x: null, y });
    expect(reduceDrawerSlots(cleared, { type: 'pick', column: continuous('new-x') })).toMatchObject({ x: continuous('new-x'), y });
  });

  it('does not put the same column in both slots', () => {
    const x = continuous('x');
    const withX = reduceDrawerSlots(EMPTY_DRAWER_SLOTS, { type: 'pick', column: x });
    expect(reduceDrawerSlots(withX, { type: 'pick', column: x }).y).toBeNull();
    const withY = reduceDrawerSlots(withX, { type: 'pick', column: continuous('y') });
    const focusX = reduceDrawerSlots(withY, { type: 'focus', slot: 'x' });
    expect(reduceDrawerSlots(focusX, { type: 'pick', column: continuous('y') })).toMatchObject({ x: continuous('y'), y: null });
  });
});
