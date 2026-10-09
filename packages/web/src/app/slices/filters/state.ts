import type { GlobalState, SelectionState } from '../../graph/state';

export interface FiltersState {
  global: GlobalState;
  selections: readonly SelectionState[];
}
