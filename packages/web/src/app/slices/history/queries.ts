import {
type QueryKey
} from '@mriqc/shared';
import { queryKey,type Query } from '../../api/api';
import { exportCountQuery } from '../../chrome/export-view';
import { type State } from '../../graph/state';
import { clusterKeys,panelKeys,panelQueries } from "../panels/queries";
import { CATALOG_KEY } from "./results";


/** Every key any panel references, plus the catalog. Eviction spares these. */
export function referencedKeys(state: State): Set<QueryKey> {
  const keys = new Set<QueryKey>([CATALOG_KEY]);
  if (state.exportDialogOpen) keys.add(queryKey(exportCountQuery(state)));
  for (const panel of state.panels) {
    for (const key of panelKeys(state, panel)) keys.add(key);
    for (const local of clusterKeys(state, panel)) keys.add(local);
  }
  return keys;
}


/** True when the datasets map already answers this key at the current version. */
export function satisfied(state: State, key: QueryKey): boolean {
  const entry = state.datasets[key];
  return entry !== undefined && entry.version === state.dataVersion;
}


/**
 * The effects contract, as a map so the runner has the query and not only its
 * key. `needed` is the documented set; this is the same thing with the
 * parameters still attached, which saves parsing a key back into a query.
 */
export function neededQueries(state: State): ReadonlyMap<QueryKey, Query> {
  const out = new Map<QueryKey, Query>();
  const count = exportCountQuery(state);
  if (state.exportDialogOpen && !satisfied(state, queryKey(count))) out.set(queryKey(count), count);
  // Membership is "has no entry at the current version", for the catalog
  // exactly as for every panel key: its value lists, date range and metric
  // counts are computed per ingest, so a version change makes it needed again.
  //
  // Deliberately *not* "or while the catalog is null". A failed catalog fetch
  // leaves an error entry and no catalog, and keeping the key needed forever on
  // that account retried nothing -- the runner starts a fetch for a key that
  // *enters* the set, and this one never left -- while holding `pendingCount`
  // above zero, which is what pinned the status line on "Loading the metric
  // catalogue". An error entry satisfies its key; `retryKey` deletes the entry,
  // and that re-entry is what restarts the fetch.
  if (!satisfied(state, CATALOG_KEY)) {
    out.set(CATALOG_KEY, { source: 'population', proc: 'catalog' });
  }
  for (const panel of state.panels) {
    for (const query of panelQueries(state, panel)) {
      const key = queryKey(query);
      if (!satisfied(state, key) && !out.has(key)) out.set(key, query);
    }
  }
  return out;
}


/** The set of query keys for which no entry exists at the current `dataVersion`. */
export function needed(state: State): Set<QueryKey> {
  return new Set(neededQueries(state).keys());
}
