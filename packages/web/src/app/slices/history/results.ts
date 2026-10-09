import { type DistributionResult, type QueryKey } from '@mriqc/shared';
import { queryKey } from '../../api/api';
import { type State } from '../../graph/state';
import { asDistributionResult } from '../../panels/specs';


export const CATALOG_KEY: QueryKey = queryKey({ source: 'population', proc: 'catalog' });

export function resultOf<T>(state: State, key: QueryKey | undefined): T | null {
  if (key === undefined) return null;
  const entry = state.datasets[key];
  return entry?.status === 'ready' ? (entry.result as T) : null;
}


/** The same, shape-checked: `asDistributionResult` says why that matters. */
export function distributionResult(
  state: State,
  key: QueryKey | undefined,
): DistributionResult | null {
  return asDistributionResult(resultOf<unknown>(state, key));
}
