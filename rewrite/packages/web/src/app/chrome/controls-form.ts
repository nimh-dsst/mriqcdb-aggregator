/**
 * The global controls, as a reactive form.
 *
 * The form is a command *source*: its `valueChanges` become `setModality`,
 * `setView` and `setFilters`, and the reducer's own resets are pushed back into
 * it with `emitEvent: false` (`graph.ts`, edge 3). It holds no state the graph
 * does not already hold -- which is why the mapping both ways lives here, as
 * two pure functions over a plain value, and is unit-tested as such.
 *
 * The cohort editor builds the same form (`chrome/cohort-editor.ts`): a cohort
 * carries the same view and the same filter set the top bar produces, so it is
 * edited with the same controls and read back with the same
 * {@link filtersFromForm} -- including the numeric ranges and the date range it
 * does not render, which is what keeps "Duplicate this dashboard" from silently
 * dropping the filters it cannot show.
 */

import { FormControl, FormGroup } from '@angular/forms';
import {
  asColumnId,
  canonicalViewFor,
  getAuthoredCatalog,
  type Filter,
  type FilterValue,
  type Modality,
  type View,
} from '@mriqc/shared';
import { OPEN_HI, OPEN_LO } from '../graph/filters';
import type { GlobalState } from '../graph/state';

/**
 * The filterable fields the top bar exposes as multi-selects: every categorical
 * field the authored catalog marks filterable, in catalog order.
 *
 * The union over every modality and view, not the current one: a reactive form
 * cannot grow and shrink controls under a `formControlName` without losing the
 * value the control held, and `chrome.filterFields` already decides which of
 * these are rendered for the modality and view on screen. A control whose field
 * the current view does not have simply has nothing bound to it, and the
 * reducer drops the filter anyway (`validFilters`).
 *
 * Date and numeric filterable fields are not here: `created_at` is the range
 * picker's, and the numeric ones have {@link FORM_NUMERIC_FIELDS}.
 */
export const FORM_FILTER_FIELDS: readonly string[] = getAuthoredCatalog()
  .fields.filter((field) => field.filterable && field.kind === 'categorical')
  .map((field) => field.id);

/**
 * The filterable fields the top bar exposes as a two-ended range: every numeric
 * field the authored catalog marks filterable, in catalog order.
 *
 * The union over every modality and view, for the same reason
 * {@link FORM_FILTER_FIELDS} is one -- `canonical_diameter` and
 * `canonical_group_rows` exist on the canonical views only, and a control whose
 * field the current view lacks simply has nothing bound to it.
 */
export const FORM_NUMERIC_FIELDS: readonly string[] = getAuthoredCatalog()
  .fields.filter((field) => field.filterable && field.kind === 'numeric')
  .map((field) => field.id);


// Re-exported where the form layer and its tests have always read them.
export { OPEN_HI, OPEN_LO };

/** One numeric field's range control: either end may be left empty. */
export interface NumericBounds {
  lo: number | null;
  hi: number | null;
}

/** An empty value for every filter control, which is what "clear filters" writes. */
export function emptyFilterControls(): Record<string, FilterValue[]> {
  return Object.fromEntries(FORM_FILTER_FIELDS.map((field) => [field, []]));
}

/** Both ends empty for every range control; the other half of "clear filters". */
export function emptyNumericControls(): Record<string, NumericBounds> {
  return Object.fromEntries(FORM_NUMERIC_FIELDS.map((field) => [field, { lo: null, hi: null }]));
}

/**
 * Shape of the reactive form that drives the global controls. The categorical
 * filters and the numeric ranges live in nested groups so the set of them can
 * come from the catalog while the form stays typed.
 */
export interface ControlsValue {
  modality: Modality;
  view: View;
  filters: Record<string, FilterValue[]>;
  numeric: Record<string, NumericBounds>;
  createdFrom: Date | null;
  createdTo: Date | null;
}

/**
 * A fresh controls form.
 *
 * Exported because the cohort editor builds its own: a cohort carries the same
 * view and the same filter set the top bar produces, so it is edited with the
 * same controls and read back with the same {@link filtersFromForm} -- including
 * the numeric ranges and the date range it does not render, which is what keeps
 * "Duplicate this dashboard" from silently dropping the filters it cannot show.
 */
export function buildControlsForm() {
  const filters: Record<string, FormControl<FilterValue[]>> = {};
  for (const field of FORM_FILTER_FIELDS) {
    filters[field] = new FormControl<FilterValue[]>([], { nonNullable: true });
  }
  const numeric: Record<string, FormGroup<NumericBoundControls>> = {};
  for (const field of FORM_NUMERIC_FIELDS) {
    numeric[field] = new FormGroup({
      lo: new FormControl<number | null>(null),
      hi: new FormControl<number | null>(null),
    });
  }
  return new FormGroup({
    modality: new FormControl<Modality>('bold', { nonNullable: true }),
    view: new FormControl<View>(canonicalViewFor('bold'), { nonNullable: true }),
    filters: new FormGroup(filters),
    numeric: new FormGroup(numeric),
    createdFrom: new FormControl<Date | null>(null),
    createdTo: new FormControl<Date | null>(null),
  });
}

interface NumericBoundControls {
  lo: FormControl<number | null>;
  hi: FormControl<number | null>;
}

/**
 * A date control's value, or null when it holds something that is not a usable
 * instant. A datepicker hands back `Invalid Date` for a half-typed date, and
 * `toISOString()` on one throws -- inside a source's `map`, which would error
 * the fold.
 */
function usableDate(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value;
}

/** The same check for a bound that arrived as a string or a number from a link. */
function parseDate(value: number | string): Date | null {
  return usableDate(new Date(value));
}

/**
 * A range control's end, or null when it holds nothing usable. A number input
 * hands back null for an empty box, but a half-typed `1e` or a hand-set value
 * reaches here as a string, and a non-finite bound is one the server refuses.
 */
function usableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The controls form, as a `Filter[]` the catalog will accept. */
export function filtersFromForm(value: Partial<ControlsValue>): Filter[] {
  const filters: Filter[] = [];
  for (const field of FORM_FILTER_FIELDS) {
    const values = value.filters?.[field] ?? [];
    if (values.length > 0) filters.push({ field: asColumnId(field), op: 'in', values });
  }
  for (const field of FORM_NUMERIC_FIELDS) {
    const bounds = value.numeric?.[field];
    const lo = usableNumber(bounds?.lo);
    const hi = usableNumber(bounds?.hi);
    // Both ends empty is no filter at all, which is how clearing the boxes
    // removes it rather than widening it to everything.
    if (lo === null && hi === null) continue;
    // Ordered, like the brush: a max typed below the min is a half-finished
    // entry, and the server answers a reversed range with BAD_REQUEST.
    const [min, max] =
      lo !== null && hi !== null && lo > hi ? [hi, lo] : [lo ?? OPEN_LO, hi ?? OPEN_HI];
    filters.push({ field: asColumnId(field), op: 'between', lo: min, hi: max });
  }
  const from = usableDate(value.createdFrom);
  const to = usableDate(value.createdTo);
  if (from && to) {
    filters.push({
      field: asColumnId('created_at'),
      op: 'between',
      lo: from.toISOString(),
      hi: to.toISOString(),
    });
  }
  return filters;
}

/** The inverse, for pushing a hydrated or reset state back into the controls. */
export function formFromGlobal(global: GlobalState): ControlsValue {
  const value: ControlsValue = {
    modality: global.modality,
    view: global.view,
    filters: emptyFilterControls(),
    numeric: emptyNumericControls(),
    createdFrom: null,
    createdTo: null,
  };
  for (const filter of global.filters) {
    if (filter.op === 'in' && FORM_FILTER_FIELDS.includes(filter.field)) {
      value.filters[filter.field] = [...filter.values];
    }
    if (filter.op === 'between' && FORM_NUMERIC_FIELDS.includes(filter.field)) {
      const lo = typeof filter.lo === 'number' ? filter.lo : null;
      const hi = typeof filter.hi === 'number' ? filter.hi : null;
      // An open end comes back empty, so the control shows what the user typed
      // and not the sentinel that stood in for what they did not.
      value.numeric[filter.field] = {
        lo: lo === OPEN_LO ? null : lo,
        hi: hi === OPEN_HI ? null : hi,
      };
    }
    if (filter.op === 'between' && filter.field === 'created_at') {
      const from = parseDate(filter.lo);
      const to = parseDate(filter.hi);
      // A bound a link carried that is not a date never reaches the controls:
      // an `Invalid Date` in the form throws on the next control change.
      if (from && to) {
        value.createdFrom = from;
        value.createdTo = to;
      }
    }
  }
  return value;
}

export function sameControls(a: ControlsValue, b: ControlsValue): boolean {
  const sameList = (x: FilterValue[], y: FilterValue[]) =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  const sameDate = (x: Date | null, y: Date | null) =>
    (x?.getTime() ?? null) === (y?.getTime() ?? null);
  const sameBounds = (x: NumericBounds | undefined, y: NumericBounds | undefined) =>
    usableNumber(x?.lo) === usableNumber(y?.lo) && usableNumber(x?.hi) === usableNumber(y?.hi);
  return (
    a.modality === b.modality &&
    a.view === b.view &&
    FORM_FILTER_FIELDS.every((f) => sameList(a.filters[f] ?? [], b.filters[f] ?? [])) &&
    FORM_NUMERIC_FIELDS.every((f) => sameBounds(a.numeric[f], b.numeric[f])) &&
    sameDate(a.createdFrom, b.createdFrom) &&
    sameDate(a.createdTo, b.createdTo)
  );
}
