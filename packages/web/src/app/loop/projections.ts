import type { QueryKey } from '@mriqc/shared';
import type { Query } from '../api/api';

export function sameKeySets(a: ReadonlyMap<QueryKey, Query>, b: ReadonlyMap<QueryKey, Query>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}
