export type DrawerSlot = 'x' | 'y';

/**
 * The picker supplies these two capability flags from its field/metric
 * definitions.  Keeping them here makes slot selection independent of the
 * grouping and filtering used by the drawer UI.
 */
export interface DrawerSlotColumn {
  readonly id: string;
  readonly isNumeric: boolean;
  readonly isContinuous: boolean;
}

export interface DrawerSlots<TColumn extends DrawerSlotColumn = DrawerSlotColumn> {
  readonly x: TColumn | null;
  readonly y: TColumn | null;
  readonly focused: DrawerSlot;
}

export type DrawerSlotsAction<TColumn extends DrawerSlotColumn = DrawerSlotColumn> =
  | { readonly type: 'pick'; readonly column: TColumn }
  | { readonly type: 'focus'; readonly slot: DrawerSlot }
  | { readonly type: 'clear'; readonly slot: DrawerSlot }
  | { readonly type: 'swap' };

export const EMPTY_DRAWER_SLOTS: DrawerSlots = {
  x: null,
  y: null,
  focused: 'x',
};

export function canUseAsY(column: DrawerSlotColumn, x: DrawerSlotColumn | null): boolean {
  return column.id !== x?.id && column.isContinuous && x !== null;
}

export function canSwapDrawerSlots(slots: DrawerSlots): boolean {
  return slots.x?.isContinuous === true && slots.y?.isContinuous === true;
}

/** Applies one direct drawer-slot gesture while maintaining the X/Y invariant. */
export function reduceDrawerSlots<TColumn extends DrawerSlotColumn>(
  slots: DrawerSlots<TColumn>,
  action: DrawerSlotsAction<TColumn>,
): DrawerSlots<TColumn> {
  switch (action.type) {
    case 'focus':
      return { ...slots, focused: action.slot };

    case 'clear':
      if (action.slot === 'x') {
        return { ...slots, x: null, focused: 'x' };
      }
      return { ...slots, y: null, focused: 'y' };

    case 'swap':
      if (!canSwapDrawerSlots(slots)) {
        return slots;
      }
      return { x: slots.y, y: slots.x, focused: slots.focused };

    case 'pick': {
      const { column } = action;

      if (slots.x === null) {
        return { x: column, y: column.isContinuous && slots.y?.id !== column.id ? slots.y : null, focused: 'y' };
      }

      if (slots.focused === 'x') {
        return {
          x: column,
          y: column.isContinuous && slots.y?.id !== column.id ? slots.y : null,
          focused: 'x',
        };
      }

      if (canUseAsY(column, slots.x)) {
        if (column.id === 'created_at' && slots.x.isContinuous) return { x: column, y: slots.x, focused: 'y' };
        return { ...slots, y: column, focused: 'y' };
      }

      return { x: column, y: null, focused: 'y' };
    }
  }
}
