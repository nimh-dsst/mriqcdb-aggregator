/**
 * The datasets map: writing one entry, and dropping the ones nothing reads.
 *
 * Recency is the record's own key order, which `touch` maintains, so eviction
 * is least-recently-written over the unreferenced entries and needs no
 * timestamps in state.
 */

import type { QueryKey } from '@mriqc/shared';
import { EVICTION_KEEP,type DatasetEntry,type State } from '../../graph/state';
import { referencedKeys } from './queries';

/**
 * Write one dataset entry, moving its key to the back of the record.
 *
 * Spreading over an existing key keeps that key's original position, which
 * would make eviction drop an entry the user just re-referenced ahead of
 * genuinely older ones. Deleting before re-inserting makes the record's key
 * order a least-recently-written order, which is what `evict` reads.
 */
export function touch(
  datasets: Readonly<Record<QueryKey, DatasetEntry>>,
  key: QueryKey,
  entry: DatasetEntry,
): Record<QueryKey, DatasetEntry> {
  const next: Record<QueryKey, DatasetEntry> = { ...datasets };
  delete next[key];
  next[key] = entry;
  return next;
}

/**
 * Drop entries no panel references any more, keeping the most recently
 * written `EVICTION_KEEP` of them so toggling a control back and forth does
 * not refetch. Recency is the datasets record's own key order, which `touch`
 * maintains: query keys are never integer-like, so JavaScript preserves it.
 */
export function evict(state: State): State {
  const referenced = referencedKeys(state);
  const keys = Object.keys(state.datasets);
  const unreferenced = keys.filter((key) => !referenced.has(key));
  if (unreferenced.length <= EVICTION_KEEP) return state;
  const dropped = new Set(unreferenced.slice(0, unreferenced.length - EVICTION_KEEP));
  const datasets: Record<QueryKey, DatasetEntry> = {};
  for (const key of keys) if (!dropped.has(key)) datasets[key] = state.datasets[key];
  return { ...state, datasets };
}
