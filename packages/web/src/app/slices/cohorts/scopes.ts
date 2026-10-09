import {
  NONE_FILTER_VALUE,
  asColumnId,
  fieldValueLabel,
  fieldsFor,
  isNoneValue,
  isValidField,
} from '@mriqc/shared';
import {
  ALL_COHORT,
  ALL_COHORT_COLOR,
  CURRENT_COHORT,
  CURRENT_COHORT_COLOR,
  STUDY_COHORT,
  STUDY_COHORT_COLOR,
  groupCohortId,
  parseGroupCohortId,
  type Cohort,
  type CohortId,
  type State,
} from '../../graph/state';
import { CATEGORY_PALETTE, MAX_CATEGORIES, groupColorIndex, groupRange } from '../../panels/specs';


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
