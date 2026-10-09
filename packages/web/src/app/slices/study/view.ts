import type { State } from '../../graph/state';

/** Session-local study and export status for the chrome projection. */
export function studyView(state: State) {
  return { study: state.study, export: state.export };
}
