import { validSelections } from './selections';
/**
 * The cohorts a dashboard has, derived from one state value.
 *
 * `State.cohorts` holds the user's cohorts only. Three kinds are derived here
 * instead of stored, so none of them can drift from what they name
 * (`docs/comparison-design.md`, "Cohort"):
 *
 * - `current` ("This dashboard") and `all` ("Whole population"), from `global`
 *   and `selection`;
 * - one per group of a split field, whose id *is* its definition.
 *
 * Pure functions of state, like everything else right of `state$`.
 */

import {
  NONE_FILTER_VALUE,
  asColumnId,
  canonicalViewFor,
  fieldValueLabel,
  fieldsFor,
  isNoneValue,
  isValidField,
  isValidMetric,
  viewsFor,
  type Filter,
  type Modality,
  type Selection,
  type View,
} from '@mriqc/shared';
import { CATEGORY_PALETTE, MAX_CATEGORIES, cohortColor, groupColorIndex, groupRange } from '../panels/specs';
import type { CohortPatch } from './commands';
import { sameFilters, validFilters } from './filters';
import {
  ALL_COHORT,
  ALL_COHORT_COLOR,
  CURRENT_COHORT,
  CURRENT_COHORT_COLOR,
  STUDY_COHORT,
  STUDY_COHORT_COLOR,
  MAX_COHORTS,
  groupCohortId,
  isDerivedCohort,
  isGroupCohort,
  parseGroupCohortId,
  type Cohort,
  type CohortId,
  type State,
} from './state';

/** What "This dashboard" and "Whole population" are called everywhere. */
export const CURRENT_COHORT_NAME = 'This dashboard';
export const ALL_COHORT_NAME = 'Whole population';

/**
 * The cohort "This dashboard": the global view, filters and brush as they stand.
 *
 * Derived rather than stored, so it can never drift from the top bar. It carries
 * the dashboard's brush as its own metric range, which is what makes "compare
 * the brushed subset against everything" a comparison a user can set up in one
 * click -- and `panelCohorts` is where a panel that *drew* that brush drops it
 * again, because no panel filters itself.
 */
export function currentCohort(state: State): Cohort {
  return {
    id: CURRENT_COHORT,
    name: CURRENT_COHORT_NAME,
    color: CURRENT_COHORT_COLOR,
    source: 'population',
    view: state.global.view,
    filters: state.global.filters,
    selections: state.selections.map(({ metric, range }) => ({ metric, range })),
  };
}

/** The cohort "Whole population": the global view with no filters and no brush. */
export function allCohort(state: State): Cohort {
  return {
    id: ALL_COHORT,
    name: ALL_COHORT_NAME,
    color: ALL_COHORT_COLOR,
    source: 'population',
    view: state.global.view,
    filters: [],
    selections: [],
  };
}

/** The loaded local study, derived so it is never serialized or editable. */
export function studyCohort(state: State): Cohort | null {
  if (typeof state.study !== 'object' || state.study.status !== 'ready') return null;
  return {
    id: STUDY_COHORT,
    name: 'My study',
    color: STUDY_COHORT_COLOR,
    source: 'study',
    // Study queries have one table and ignore views; the field remains required
    // by the shared cohort vocabulary and keeps query keys modality-scoped.
    view: state.global.view,
    filters: [],
    selections: [],
  };
}

/** Every cohort a panel may reference: the two derived ones, then the user's, in order. */
export function cohortsOf(state: State): readonly Cohort[] {
  const study = studyCohort(state);
  return study === null
    ? [currentCohort(state), allCohort(state), ...state.cohorts]
    : [currentCohort(state), allCohort(state), study, ...state.cohorts];
}

/**
 * One group of a split, as a cohort: this dashboard's view and filters plus
 * `field in [value]`.
 *
 * Derived from the id, which carries the field and the value and is therefore
 * the whole definition -- there is nothing to store, and a link only has to say
 * which group of which column it meant. Null when the catalog has no such filter
 * column for this `(modality, view)`, which is the same rule a filter from a
 * link gets.
 *
 * The colour is the group's own slot in the split field's value list, so a
 * cohort made from a split group wears the hue that group had on the chart it
 * was selected from. The list is the catalog's, ordered by count, which is the
 * one ordering that is a fact about the ingest rather than about a result that
 * may no longer be on screen.
 */
export function groupCohort(state: State, id: CohortId): Cohort | null {
  const parsed = parseGroupCohortId(id);
  if (parsed === null) return null;
  const { modality, view } = state.global;
  const field = asColumnId(parsed.field);
  if (!isValidField(modality, view, field, 'filter')) return null;
  const def = fieldsFor(modality, view, 'filter').find((f) => f.id === field);
  const valueLabel = fieldValueLabel(parsed.field, parsed.value);
  const displayLabel = valueLabel === 'other' ? 'Other' : valueLabel;
  const labels = (state.catalog?.fieldValues[parsed.field]?.[modality]?.[view] ?? [])
    .slice(0, MAX_CATEGORIES).map((entry) => fieldValueLabel(parsed.field, entry.value));
  const color = groupRange(labels)[labels.indexOf(displayLabel)];
  return {
    id,
    name: `${def?.label ?? parsed.field}: ${valueLabel}`,
    color: color ? CATEGORY_PALETTE.indexOf(color) : groupColorIndex(displayLabel),
    source: 'population',
    view,
    filters: [...state.global.filters, { field, op: 'in', values: [parsed.value] }],
    selections: [],
  };
}

/** One cohort by id, derived or stored, or null when nothing answers to it. */
export function cohortById(state: State, id: CohortId): Cohort | null {
  if (id === CURRENT_COHORT) return currentCohort(state);
  if (id === ALL_COHORT) return allCohort(state);
  if (id === STUDY_COHORT) return studyCohort(state);
  const group = groupCohort(state, id);
  if (group !== null) return group;
  return state.cohorts.find((cohort) => cohort.id === id) ?? null;
}

/**
 * The cohorts one split field offers: one per value the catalog knows, capped at
 * the palette so the "Add cohort…" menu stays a menu.
 *
 * Empty for a panel that is not split, which is why "Compare selected" only
 * appears on one that is.
 */
export function splitCohorts(state: State, field: CohortId | null): readonly Cohort[] {
  if (field === null) return [];
  const { modality, view } = state.global;
  const values = state.catalog?.fieldValues[String(field)]?.[modality]?.[view] ?? [];
  return values.slice(0, MAX_CATEGORIES).flatMap((entry) => {
    const value = isNoneValue(entry.value) ? NONE_FILTER_VALUE : String(entry.value);
    const cohort = groupCohort(state, groupCohortId(field, value));
    return cohort === null ? [] : [cohort];
  });
}

/**
 * One cohort as the top bar's chip row and a card's chip row read it: the whole
 * cohort, because the editor duplicates from it, plus the hue it wears and
 * whether it can be edited at all.
 */
export interface CohortChip {
  cohort: Cohort;
  color: string;
  /** False for `current`, `all` and a split group: none of them is stored. */
  editable: boolean;
}

/** One cohort as a chip. */
export function cohortChip(cohort: Cohort): CohortChip {
  return { cohort, color: cohortColor(cohort.color), editable: !isDerivedCohort(cohort.id) };
}

/**
 * The cohort list: the two derived cohorts and then the user's, in order.
 *
 * Its own projection rather than a field of `chrome`, so a rename re-renders one
 * row of chips and not the whole top bar -- and so `chromeEquals` does not grow
 * a deep comparison over a list whose contents change.
 */
export function cohortList(state: State): readonly CohortChip[] {
  return cohortsOf(state).map(cohortChip);
}

/** Element-wise equality for `cohortList`, for `distinctUntilChanged`. */
export function cohortListEquals(a: readonly CohortChip[], b: readonly CohortChip[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const x = entry.cohort;
      const y = b[i].cohort;
      return (
        x.id === y.id &&
        x.name === y.name &&
        x.color === y.color &&
        x.source === y.source &&
        x.view === y.view &&
        x.filters === y.filters &&
        // By value, not by reference: `currentCohort` builds its selection fresh
        // on every call, so an identity check here would re-emit the whole chip
        // row on every command while a brush is active.
        sameSelection(x.selections, y.selections)
      );
    })
  );
}

function sameRange(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.metric === b.metric && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}

/* ------------------------------------------- minting, validating, patching */

/**
 * The next free cohort id, from the highest `c<n>` already present.
 *
 * Exported and pure, like `nextCohortColor`, because the caller has to name the
 * cohort it is about to create -- "Compare with… / New cohort…" dispatches
 * `addCohort` and then `convertToComparison` with the same id. The reducer
 * re-mints anything that turns out to collide, so calling this is a convenience
 * and never a correctness requirement.
 */
export function mintCohortId(cohorts: readonly Cohort[]): CohortId {
  let max = 0;
  for (const cohort of cohorts) {
    const match = /^c(\d+)$/.exec(cohort.id);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n)) max = Math.max(max, n);
  }
  const taken = new Set<string>([...cohorts.map((c) => c.id), CURRENT_COHORT, ALL_COHORT]);
  let candidate = max + 1;
  while (taken.has(`c${candidate}`)) candidate += 1;
  return `c${candidate}`;
}

/**
 * The lowest palette slot no cohort holds, counting the two derived ones.
 *
 * Lowest-free rather than next-in-sequence, so deleting a cohort releases its
 * hue instead of walking the palette off its end; the slot is then fixed for the
 * life of that cohort. Past eight cohorts it wraps, which is a reuse the legend
 * and the coloured stats table still disambiguate by name.
 */
export function nextCohortColor(cohorts: readonly Cohort[]): number {
  const taken = new Set<number>([CURRENT_COHORT_COLOR, ALL_COHORT_COLOR, STUDY_COHORT_COLOR]);
  for (const cohort of cohorts) taken.add(cohort.color);
  for (let slot = 0; slot < CATEGORY_PALETTE.length; slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return cohorts.length % CATEGORY_PALETTE.length;
}

/**
 * Structural equality for a cohort, so an `updateCohort` that changes nothing --
 * the editor saves its whole value on every Save -- leaves the state reference
 * alone and re-derives no panel.
 */
function sameCohort(a: Cohort, b: Cohort): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.color === b.color &&
    a.source === b.source &&
    a.view === b.view &&
    sameFilters(a.filters, b.filters) &&
    sameSelection(a.selections, b.selections)
  );
}

function sameSelection(a: Cohort['selections'], b: Cohort['selections']): boolean {
  return a === b || (a.length === b.length && a.every((selection, i) => sameRange(selection, b[i])));
}

/** A cohort name that is actually a name, with a fallback rather than a rejection. */
function cohortName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : '';
  return text === '' ? 'Cohort' : text.slice(0, 80);
}

/**
 * A cohort as the dashboard will hold it: a usable name, a view this modality
 * has, filters the catalog marks filterable in that view, and a metric range on
 * a metric this modality has.
 *
 * The same discipline every other command gets: a cohort can arrive from a
 * shared link or from a component holding a stale catalog, and from there it
 * reaches a query key and the server.
 */
function validCohort(cohort: Cohort, state: State): Cohort {
  const { modality } = state.global;
  const views = viewsFor(modality).map((v) => v.id);
  const view = views.includes(cohort.view) ? cohort.view : canonicalViewFor(modality);
  const selections = validSelections(cohort.selections, modality);
  return {
    id: cohort.id,
    name: cohortName(cohort.name),
    color: Number.isFinite(cohort.color) ? Math.trunc(cohort.color) : 0,
    source: cohort.source === 'study' ? 'study' : 'population',
    view,
    filters: validFilters(cohort.filters, modality, view),
    selections,
  };
}

/**
 * True when some cohort answers to this id: one of the two built-ins, one the
 * user stored, or a group of a column this `(modality, view)` can filter on.
 *
 * State-aware rather than a set, because a group cohort has nothing stored --
 * its id *is* its definition (`g\0field\0value`), so what makes it known is
 * that the catalog still has that column as a filter here. A link carrying a
 * group of a column this view does not have is the same case as a link carrying
 * a filter on it: dropped.
 */
export function isKnownCohortId(state: State, id: CohortId): boolean {
  if (typeof id !== 'string') return false;
  if (id === CURRENT_COHORT || id === ALL_COHORT) return true;
  if (id === STUDY_COHORT) return studyCohort(state) !== null;
  const group = parseGroupCohortId(id);
  if (group !== null) {
    const { modality, view } = state.global;
    // `filter` and not `group`: a group cohort *is* `field in [value]`, so what
    // it needs is a column the server will accept a predicate on.
    return isValidField(modality, view, asColumnId(group.field), 'filter');
  }
  return state.cohorts.some((cohort) => cohort.id === id);
}

/**
 * A panel's cohort list, with unknown ids and repeats dropped.
 *
 * Order is the panel's own, because it decides which cohort the differences
 * block subtracts from and which curve is drawn first.
 */
export function validCohortList(
  ids: readonly CohortId[] | undefined,
  state: State,
): readonly CohortId[] {
  if (ids === undefined) return [];
  const out: CohortId[] = [];
  for (const id of ids) {
    if (!isKnownCohortId(state, id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Every cohort re-pointed at a modality that may not have its view, its filter
 * columns or its metric.
 *
 * The view falls back to the new modality's canonical one, exactly as the top
 * bar's does; filters the new `(modality, view)` has no column for are dropped;
 * a metric range on a metric the modality does not have goes, because the two
 * bounds mean nothing on a different metric. A cohort keeps its id, its name and
 * its colour throughout, so the comparison panels that reference it survive.
 */
export function retargetCohorts(cohorts: readonly Cohort[], modality: Modality): readonly Cohort[] {
  const views = viewsFor(modality).map((v) => v.id);
  let changed = false;
  const next = cohorts.map((cohort) => {
    const view = views.includes(cohort.view) ? cohort.view : canonicalViewFor(modality);
    const filters = validFilters(cohort.filters, modality, view);
    const selections = validSelections(cohort.selections, modality);
    if (
      view === cohort.view &&
      filters.length === cohort.filters.length &&
      sameSelection(selections, cohort.selections)
    ) {
      return cohort;
    }
    changed = true;
    return { ...cohort, view, filters, selections };
  });
  return changed ? next : cohorts;
}

/**
 * The cohort a `create` patch is written over: everything a cohort needs that
 * the patch may leave out.
 *
 * The view is the dashboard's, because a cohort made here is a slice of what is
 * on screen, and the colour is the lowest free palette slot.
 */
function blankCohort(state: State, id: CohortId): Cohort {
  return {
    id,
    name: 'Cohort',
    color: nextCohortColor(state.cohorts),
    source: 'population',
    view: state.global.view,
    filters: [],
    selections: [],
  };
}

/**
 * One path for every change to the cohort list: a patch over the cohort this id
 * names, or -- when `create` is set and no cohort answers to it -- a new cohort
 * built from the same patch over {@link blankCohort}.
 *
 * `addCohort`, `updateCohort`, `patchCohort` and `saveCurrentAsCohort` all come
 * through here, so the cap, the reserved ids, the group-cohort refusal and the
 * catalog validation are stated once.
 *
 * Returns the new list, or null when nothing changed -- which is what lets the
 * reducer decide whether to evict, and keeps this module from reaching back
 * into the datasets map.
 */
export function patchCohort(
  state: State,
  id: CohortId,
  patch: CohortPatch,
  create: boolean,
): readonly Cohort[] | null {
  if (create) {
    // A group cohort is derived from its id, so storing one would be a second
    // definition of the same thing, able to drift from the split it names.
    if (isGroupCohort(id)) return null;
    if (state.cohorts.length >= MAX_COHORTS) return null;
    // The caller's id when it is usable, a freshly minted one when it is taken,
    // reserved or not a string. Either way the cohort is added: the user asked
    // for it, only its name was unusable.
    const minted =
      typeof id === 'string' && id !== '' && !isKnownCohortId(state, id)
        ? id
        : mintCohortId(state.cohorts);
    const made = validCohort({ ...blankCohort(state, minted), ...patch, id: minted }, state);
    return [...state.cohorts, made];
  }
  const existing = state.cohorts.find((cohort) => cohort.id === id);
  // The derived cohorts follow the top bar and are not stored, so there is
  // nothing here to patch; an update naming one is a no-op rather than an error.
  if (existing === undefined) return null;
  const next = validCohort({ ...existing, ...patch, id }, state);
  // The editor saves its whole value on every Save, so a patch that changes
  // nothing has to leave the state reference alone and re-derive no panel.
  if (sameCohort(next, existing)) return null;
  return state.cohorts.map((cohort) => (cohort.id === id ? next : cohort));
}
