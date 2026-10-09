/** Pure feature transitions; foreign commands preserve state identity. */

import { isDerivedCohort, type State } from '../../graph/state';
import { cohortChange, type Command } from '../commands';
import { mintCohortId, patchCohort, retargetCohorts } from './model';
import { cohortAutoName, uniqueCohortName } from './name';

export function reduceCohorts(state: State, command: Command): State {
  switch (command.t) {
    case 'addCohort':

    case 'patchCohort':

    case 'updateCohort': {
      // All three are the same operation: a patch over the cohort an id names,
      // creating it when the command says it may (`commands.ts`, `cohortChange`).
      const change = cohortChange(command);
      if (change === null) return state;
      const cohorts = patchCohort(state, change.id, change.patch, change.create);
      return cohorts === null ? state : ({ ...state, cohorts });
    }


    case 'saveCurrentAsCohort': {
      const { modality, view, filters } = state.global;
      const selections = state.selections.map(({ metric, range }) => ({ metric, range }));
      const name = uniqueCohortName(
        cohortAutoName(modality, view, filters, selections, state.catalog),
        state.cohorts.map((cohort) => cohort.name),
      );
      // A snapshot: the arrays are the ones state holds, and state is
      // immutable, so nothing can change under the cohort later. The view, the
      // colour and the source are `blankCohort`'s, which reads them off this
      // same dashboard.
      const cohorts = patchCohort(
        state,
        mintCohortId(state.cohorts),
        { name, filters, selections },
        true,
      );
      return cohorts === null ? state : ({ ...state, cohorts });
    }


    case 'removeCohort': {
      if (isDerivedCohort(command.id)) return state;
      const cohorts = state.cohorts.filter(cohort => cohort.id !== command.id);
      return cohorts.length === state.cohorts.length ? state : { ...state, cohorts };
    }

    case 'retargetCohorts': return { ...state, cohorts: retargetCohorts(state.cohorts, state.global.modality) };
    case 'hydrateCohorts': return { ...state, cohorts: command.cohorts };
    default: return state;
  }
}
