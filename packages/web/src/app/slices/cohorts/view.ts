import {
isDerivedCohort,
type Cohort,
type State
} from '../../graph/state';
import { cohortColor } from '../../panels/specs';
import { sameSelection } from "./model";
import { cohortsOf } from "./scopes";


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
