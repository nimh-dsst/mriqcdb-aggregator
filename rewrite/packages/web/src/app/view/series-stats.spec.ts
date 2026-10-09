import { describe, expect, it } from 'vitest';
import { asColumnId, type DistributionResult } from '@mriqc/shared';
import { queryKey } from '../api/api';
import { panelCohorts, panelQueries } from '../graph/queries';
import { defaultDashboard, reduce } from '../graph/reducer';
import { INITIAL_STATE, type Form } from '../graph/state';
import { panelView } from './panel-view';

const values = ['A', 'B', 'C', 'D', 'E', 'other:["F","G"]'];
const summary = (n: number): DistributionResult => ({
  n, min: 1, max: 5, mean: 3, stddev: 1,
  quantiles: { p01: 1, p05: 1, p25: 2, p50: 3, p75: 4, p95: 5, p99: 5 },
  histogram: { lo: 1, hi: 5, width: 1, counts: [n / 4, n / 4, n / 4, n / 4] },
});

function fixture(x: string, form: Form, columnY = false, selected = values) {
  let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
  state = reduce(state, { t: 'patchPanel', id: 'p1', patch: {
    x: asColumnId(x), y: columnY ? asColumnId('tsnr') : 'count', form,
    series: [{ kind: 'values', field: asColumnId('manufacturer'), values: selected }],
  } });
  const panel = state.panels[0];
  state = { ...state, dataVersion: 'v', datasets: Object.fromEntries(panelQueries(state, panel).map(query => {
    const filter = 'filters' in query ? query.filters.find(filter => filter.field === 'manufacturer' && filter.op === 'in') : undefined;
    const value = filter?.op === 'in' ? String(filter.values[0]) : '';
    const n = value ? 10 * ('ABCDEFG'.indexOf(value) + 1) : 210;
    const result = query.proc === 'coverage' ? { buckets: [{ start: '2024-01-01', group: null, n }] }
      : query.proc === 'binnedSummary' ? { xKind: x === 'created_at' ? 'time' : 'metric', yKind: 'metric', range: [1, 5],
        buckets: [{ lo: 1, hi: 5, group: null, n, mean: 3, quantiles: summary(n).quantiles, thin: false, isOther: false }] }
      : summary(n);
    return [queryKey(query), { status: 'ready' as const, version: 'v', result }];
  })) };
  return { state, panel, view: panelView(state, panel.id)! };
}

describe('series statistics across forms', () => {
  it.each(['histogram', 'band', 'line', 'area', 'density', 'ecdf', 'box'] as const)(
    'lists every count series for numeric and time %s', form => {
      for (const x of ['fd_mean', 'created_at']) {
        const { state, panel, view } = fixture(x, form);
        expect(view.analysisRows?.map(row => row.id)).toEqual(panelCohorts(state, panel).map(cohort => cohort.id));
        expect(view.analysisRows?.map(row => row.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other']);
        expect(view.analysisHeaders).toEqual(['Total', 'Difference']);
        expect(view.analysisRows?.map(row => row.cells[0])).toEqual(['10', '20', '30', '40', '50', '60']);
        expect(view.cohorts?.map(row => row.n)).toEqual([10, 20, 30, 40, 50, 60]);
      }
    },
  );

  it('keeps a single explicitly selected series in the table', () => {
    const { view } = fixture('created_at', 'band', false, ['A']);
    expect(view.analysisRows).toMatchObject([{ name: 'A', cells: ['10', '0'] }]);
  });

  it.each(['histogram', 'band', 'box'] as const)('uses column Y quantiles for every %s series', form => {
    const { state, panel, view } = fixture('created_at', form, true);
    expect(view.comparison?.rows.map(row => row.id)).toEqual(panelCohorts(state, panel).map(cohort => cohort.id));
    expect(view.comparison?.rows).toHaveLength(6);
    expect(view.comparison?.rows.map(row => row.cells[0])).toEqual(['10', '20', '30', '40', '50', '60']);
    expect(view.comparison?.rows.every(row => row.cells.includes('3'))).toBe(true);
  });
});
