/**
 * Viewport breakpoints as signals.
 *
 * This is the one piece of "state" that deliberately never reaches the graph.
 * A breakpoint is a property of the device, nobody can put it in a shared link,
 * and a command loop that folded resize events would re-derive the whole
 * dashboard on every drag of a window edge. It is read-only input to layout and
 * nothing else.
 */

import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Below this the filter bar collapses behind one button. */
export const PHONE_QUERY = '(max-width: 699px)';

/** At or above this the panel grid is two columns. */
export const TWO_COLUMN_QUERY = '(min-width: 900px)';

/** At or above this the panel grid is three columns. */
export const THREE_COLUMN_QUERY = '(min-width: 1500px)';

/**
 * A signal that tracks one media query for the life of the injection context.
 *
 * A browser (or jsdom) without `matchMedia` reads as false throughout, which is
 * the desktop layout -- the one that degrades most gracefully when the query
 * cannot be answered.
 */
export function matchesMedia(query: string): Signal<boolean> {
  const matches = signal(false);
  const media = typeof window === 'undefined' ? undefined : window.matchMedia;
  if (typeof media !== 'function') return matches.asReadonly();
  const list = window.matchMedia(query);
  matches.set(list.matches === true);
  if (typeof list.addEventListener !== 'function') return matches.asReadonly();
  const onChange = (event: MediaQueryListEvent) => matches.set(event.matches);
  list.addEventListener('change', onChange);
  inject(DestroyRef).onDestroy(() => list.removeEventListener('change', onChange));
  return matches.asReadonly();
}

/**
 * How many columns the panel grid has: 1 below 900px, 2 from 900, 3 from 1500.
 *
 * 1500 and not 1400: at 1440 -- the commonest laptop width there is -- three
 * columns make a 440px card, which is narrower than the card header was drawn
 * for and truncates the metric name in every one of them.
 */
export function gridColumns(two: boolean, three: boolean): number {
  if (three) return 3;
  return two ? 2 : 1;
}

/**
 * How many columns the last card spans, so an incomplete final row is filled
 * rather than leaving a hole beside it.
 *
 * Five panels in three columns used to draw two cards and an empty third of the
 * row; the fifth card now takes the width the row has left.
 */
export function lastCardSpan(count: number, columns: number): number {
  if (count <= 0 || columns <= 1) return 1;
  const remainder = count % columns;
  return remainder === 0 ? 1 : columns - remainder + 1;
}
