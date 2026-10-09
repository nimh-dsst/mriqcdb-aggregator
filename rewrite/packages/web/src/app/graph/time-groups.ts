import type { TimeSummaryResult } from '@mriqc/shared';

export function timeGroups(result: TimeSummaryResult) {
  const groups = new Map<string, TimeSummaryResult['buckets'][number][]>();
  for (const bucket of result.buckets) {
    const id = bucket.isOther ? 'other' : JSON.stringify([bucket.group]);
    groups.set(id, [...(groups.get(id) ?? []), bucket]);
  }
  return [...groups].map(([id, buckets]) => ({ id, buckets, n: buckets.reduce((n, bucket) => n + bucket.n, 0) }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}
