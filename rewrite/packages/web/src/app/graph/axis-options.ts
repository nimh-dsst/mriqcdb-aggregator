import type { Density2dResult, DistributionResult, GroupedSummaryResult } from '@mriqc/shared';
import { queryKey } from '@mriqc/shared';
import { panelQueries, resultOf } from './queries';
import type { Panel, State } from './state';

export function axisEvidence(state: State, panel: Panel, axis: 'x' | 'y' = 'x') {
  const summaries: { min: number | null; p05?: number }[] = panelQueries(state, panel).flatMap(query => {
    if (query.proc === 'distribution') {
      const result = resultOf<DistributionResult>(state, queryKey(query));
      return result ? result.n ? [{ min: result.min, p05: result.quantiles?.p05 }] : [] : [{ min: null }];
    }
    if (query.proc === 'groupedSummary') {
      const result = resultOf<GroupedSummaryResult>(state, queryKey(query));
      return result ? result.groups.filter(group => group.n > 0).map(group => ({ min: group.min, p05: group.quantiles?.p05 })) : [{ min: null }];
    }
    if (query.proc === 'density2d') {
      const result = resultOf<Density2dResult>(state, queryKey(query));
      return [{ min: result?.[axis].lo ?? null }];
    }
    return [];
  });
  const positive = summaries.length > 0 && summaries.every(summary => summary.min !== null && summary.min > 0);
  const magnitudes = summaries.map(summary => Math.abs(summary.p05 ?? 0)).filter(value => value > 0 && Number.isFinite(value));
  return { positive, constant: magnitudes.length ? Math.min(...magnitudes) : 1 };
}
