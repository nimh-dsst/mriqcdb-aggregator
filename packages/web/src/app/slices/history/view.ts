import type { State } from '../../graph/state';
import { needed, referencedKeys } from './queries';
import { CATALOG_KEY } from './results';

/** Loading and error counts are derived from the current version, never stored. */
export function historyView(state: State) {
  let errorCount = 0;
  for (const key of referencedKeys(state)) {
    const entry = state.datasets[key];
    if (entry?.status === 'error' && entry.version === state.dataVersion) errorCount += 1;
  }
  const catalogEntry = state.datasets[CATALOG_KEY];
  const catalogError = state.catalog === null && catalogEntry?.status === 'error' ? catalogEntry.error : null;
  return { catalogError, dataVersion: state.dataVersion, notice: state.notice, pendingCount: needed(state).size, errorCount };
}
