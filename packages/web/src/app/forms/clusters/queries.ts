import { queryKey } from '../../api/api';
import type { Panel, State } from '../../graph/state';
import type { QueryServices } from '../shared/queries';
export function localKey(state: State, panel: Panel, index: number, services: QueryServices): string | null {
  const query = services.densityQueries(state, panel)[index];
  return query ? `clusters/${queryKey(query)}/k=${panel.options.k ?? 3}/seed=${panel.options.seed ?? 42}` : null;
}
