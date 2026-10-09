import { asColumnId, queryKey, type TimeSummaryQuery, type TimeSummaryResult } from '@mriqc/shared';
import { defaultDashboard, reduce } from '../graph/reducer';
import { panelQueries, timeTailQuery } from '../graph/queries';
import { INITIAL_STATE } from '../graph/state';
import { LIGHT_THEME, OTHER_COLOR } from '../panels/specs/palette';
import { timePanelView, timeSeriesStats } from './time-view';
import { approximateTimeTail } from './time-tail';
import { compile } from 'vega-lite';

const bucket = (start: string, group: string | null, median: number, n = 30) => ({ start, group, n, isOther: false, thin: n < 20, mean: median,
  quantiles: { p05: median, p25: median, p50: median, p75: median, p95: median } });
const query: TimeSummaryQuery = { source: 'population', proc: 'timeSummary', modality: 'bold', view: 'k4plus', filters: [], selections: [], metric: asColumnId('fd_mean'), group: asColumnId('manufacturer'), granularity: 'month' };

describe('time-summary projection', () => {
  it('suppresses the cohort colour legend only when cohort chips name the series', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean'), split: null } });
    const panel = { ...state.panels[4], cohorts: ['current', 'all'] };
    state = { ...state, panels: [panel] };
    const datasets = Object.fromEntries(panelQueries(state, panel).map(query => [queryKey(query), {
      status: 'ready' as const, version: 'v', result: { buckets: [bucket('2024-01-01', null, 0.3)] },
    }]));
    const view = timePanelView({ ...state, dataVersion: 'v', datasets }, panel, LIGHT_THEME);
    expect(view.cohorts).toHaveLength(2);
    expect(JSON.stringify(compile(view.spec!).spec)).not.toContain('"legends":');
  });
  it('reports total n, chronological first/last medians and signed change', () => {
    expect(timeSeriesStats({ id: 'a', name: 'A', color: '', result: { buckets: [bucket('2024-02-01', null, 0.8), bucket('2024-01-01', null, 0.3, 10)] } }))
      .toEqual({ n: 40, first: 0.3, last: 0.8, change: 0.5, firstDate: '2024-01-01', lastDate: '2024-02-01' });
  });
  it('queries the categorical tail together for exact Other quantiles', () => {
    const result = { buckets: Array.from({ length: 8 }, (_, i) => bucket('2024-01-01', `Vendor${i}`, i, 80 - i)) };
    expect(timeTailQuery(query, result)).toEqual({ ...query, group: undefined,
      filters: [{ field: query.group, op: 'in', values: ['Vendor6', 'Vendor7'] }] });
  });
  it('keeps six named series plus neutral Other, with exact n and explicit approximation when needed', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean') } });
    const panel = state.panels[4];
    const first = panelQueries(state, panel)[0];
    const result: TimeSummaryResult = { buckets: Array.from({ length: 8 }, (_, i) => bucket('2024-01-01', `Vendor${i}`, i, 80 - i)) };
    state = { ...state, dataVersion: 'v', datasets: { [queryKey(first)]: { status: 'ready', version: 'v', result } } };
    const extra = panelQueries(state, panel)[1];
    state = { ...state, datasets: { ...state.datasets, [queryKey(extra)]: { status: 'ready', version: 'v', result: { buckets: [bucket('2024-01-01', null, 6.5, 147)] } } } };
    const view = timePanelView(state, panel, LIGHT_THEME);
    expect(view.analysisRows).toHaveLength(7);
    expect(view.analysisRows?.at(-1)).toMatchObject({ name: 'Other', color: OTHER_COLOR, cells: ['147', '6.5', '6.5', '0'] });
    expect(view.n).toBe(612);
    expect(view.analysisNote).not.toContain('approximate');
  });
  it('weights fallback quantiles by counts instead of averaging medians', () => {
    const pooled = approximateTimeTail([bucket('2024-01-01', 'a', 1, 90), bucket('2024-01-01', 'b', 100, 10)]).buckets[0];
    expect(pooled.n).toBe(100);
    expect(pooled.mean).toBe(10.9);
    expect(pooled.quantiles.p50).toBeCloseTo(1);
    expect(pooled.quantiles.p75).toBeCloseTo(1);
  });
});
