import type { State } from '../graph/state';
import { INITIAL_STATE } from '../graph/state';
import { expand } from '../loop/expand';
import { reduceCohorts } from './cohorts/reducer';
import type { Command } from './commands';
import { reduceFilters } from './filters/reducer';
import { reduceHistory } from './history/reducer';
import { reduceLayout } from './layout/reducer';
import { reducePanels } from './panels/reducer';
import { shareOnFirstSplit } from './panels/share';
import { reduceSeries } from './series/reducer';
import { reduceStudy } from './study/reducer';

export { defaultDashboard } from './panels/defaults';
export const initialState: State = INITIAL_STATE;

/** Order: filters → cohorts → panels → series → layout → study → history.
 * Each slice ignores foreign commands. Fan-out is completed synchronously
 * inside the single scan, so projections observe only the completed state.
 */
const slices = [reduceFilters, reduceCohorts, reducePanels, reduceSeries, reduceLayout, reduceStudy, reduceHistory];
export function compose(state: State, command: Command): State {
  return slices.reduce((next, slice) => slice(next, command), state);
}
function foldExpanded(state: State, command: Command): State {
  const [primary, ...reactions] = expand(command, state);
  if (!primary) return state;
  let next = primary === command ? compose(state, primary) : foldExpanded(state, primary);
  if (primary === command && next === state) return state;
  for (const reaction of reactions) next = foldExpanded(next, reaction);
  return next;
}
export function reduce(state: State, command: Command): State {
  const next = foldExpanded(state, command);
  return command.t === 'hydrate' ? next : shareOnFirstSplit(state, next);
}
