import { type Cohort,type Panel,type State } from '../../graph/state';
import { effectiveSelection } from "../filters/queries";
import { currentCohort } from './scopes';

export function panelCohort(state: State, panel: Panel): Cohort {
  return { ...currentCohort(state), selections: effectiveSelection(state, panel) };
}
