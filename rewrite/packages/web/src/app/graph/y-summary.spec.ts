import { describe, expect, it } from 'vitest';
import { asColumnId } from '@mriqc/shared';
import { INITIAL_STATE } from './state';
import { defaultDashboard, reduce } from './reducer';
import { panelCohort, panelQueries } from './queries';
import { dateSummary, ySummaryQuery } from './y-summary';

describe('temporal Y summaries', () => {
  const state = () => reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
  it('uses daily coverage for upload-date quantiles instead of an invalid metric query', () => {
    const s = state(), panel = { ...s.panels[0], y: 'created_at' as const, form: 'box' as const };
    const query = ySummaryQuery(s, panel, panelCohort(s, panel));
    expect(query).toMatchObject({ proc: 'coverage', granularity: 'day' });
    expect(panelQueries(s, panel).some(query => query.proc === 'distribution')).toBe(false);
  });
  it('computes daily date quantiles with zero-count gaps', () => {
    const summary = dateSummary({ buckets: [{ start: '2024-01-01', group: null, n: 1 }, { start: '2024-01-03', group: null, n: 3 }] });
    expect(summary?.n).toBe(4);
    expect(summary?.histogram.counts).toEqual([1, 0, 3]);
    expect(summary?.quantiles?.p50).toBe(Date.UTC(2024, 0, 3, 12));
  });
  it('uses category coverage for temporal Y bars without asking groupedSummary for a time metric', () => {
    const s = state(), panel = { ...s.panels[0], x: asColumnId('manufacturer'), y: 'created_at' as const, form: 'bars' as const };
    const queries = panelQueries(s, panel);
    expect(queries.every(query => query.proc === 'coverage')).toBe(true);
    expect(queries[0]).toMatchObject({ group: 'manufacturer', granularity: 'day' });
  });
});
