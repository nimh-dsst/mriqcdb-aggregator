import type { State } from '../graph/state';
import { INITIAL_STATE } from '../graph/state';
import { reduceCohorts } from '../slices/cohorts/reducer';
import { reduceFilters } from '../slices/filters/reducer';
import { reduceHistory } from '../slices/history/reducer';
import { reduceLayout } from '../slices/layout/reducer';
import { reducePanels } from '../slices/panels/reducer';
import { shareOnFirstSplit } from '../slices/panels/share';
import { reduceSeries } from '../slices/series/reducer';
import { reduceStudy } from '../slices/study/reducer';
import type { Command } from './commands';
import { expand } from './expand';

export { defaultDashboard } from '../slices/panels/defaults';
export const initialState: State = INITIAL_STATE;

/** Order: filters → cohorts → panels → series → layout → study → history.
 * Each slice ignores foreign commands. Fan-out is completed synchronously
 * inside the single scan, so projections observe only the completed state.
 */
const slices = [reduceFilters, reduceCohorts, reducePanels, reduceSeries, reduceLayout, reduceStudy, reduceHistory];
export function compose(state: State, command: Command): State {
  return slices.reduce((next, slice) => slice(next, command), state);
}
export function reduce(state: State, command: Command): State {
  const [primary, ...reactions] = expand(command);
  let next = compose(state, primary);
  if (next === state) return state;
  for (const reaction of reactions) next = compose(next, reaction);
  return command.t === 'hydrate' ? next : shareOnFirstSplit(state, next);
}
