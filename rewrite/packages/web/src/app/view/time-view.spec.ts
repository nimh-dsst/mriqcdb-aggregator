import { asColumnId, getAuthoredCatalog, queryKey, type CompletedCatalog, type TimeSummaryQuery, type TimeSummaryResult } from '@mriqc/shared';
import { defaultDashboard, reduce } from '../graph/reducer';
import { panelQueries, timeTailQuery } from '../graph/queries';
import { INITIAL_STATE } from '../graph/state';
import { LIGHT_THEME, OTHER_COLOR } from '../panels/specs/palette';
import { timePanelView, timeSeriesStats } from './time-view';
import { approximateTimeTail } from './time-tail';
import { compile } from 'vega-lite';
import { panelView } from './panel-view';

const bucket = (start: string, group: string | null, median: number, n = 30) => ({ start, group, n, isOther: false, thin: n < 20, mean: median,
  quantiles: { p05: median, p25: median, p50: median, p75: median, p95: median } });
const query: TimeSummaryQuery = { source: 'population', proc: 'timeSummary', modality: 'bold', view: 'k4plus', filters: [], selections: [], metric: asColumnId('fd_mean'), group: asColumnId('manufacturer'), granularity: 'month' };

describe('time-summary projection', () => {
  it.each(['band', 'lines'] as const)('dispatches %s through time summaries and its own marks', form => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'setPanelAxis', id: 'p5', axis: 'y', value: asColumnId('fd_mean') });
    state = reduce(state, { t: 'setPanelForm', id: 'p5', form });
    const panel = state.panels[4];
    const queries = panelQueries(state, panel);
    expect(queries.map(query => query.proc)).toEqual(['timeSummary']);
    const datasets = Object.fromEntries(queries.map(query => [queryKey(query), {
      status: 'ready' as const, version: 'v', result: { buckets: [bucket('2024-01-01', null, 0.3)] },
    }]));
    const view = panelView({ ...state, dataVersion: 'v', datasets }, 'p5')!;
    expect(view.hasRows).toBe(true);
    expect(JSON.stringify(view.spec)).toContain(form === 'band' ? '"area"' : 'p05');
    expect(JSON.stringify(view.spec)).not.toContain('"type":"bar"');
    expect(() => compile(view.spec!)).not.toThrow();
  });
  it('suppresses the cohort colour legend only when cohort chips name the series', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean'), form:'band', series: [] } });
    const panel = { ...state.panels[4], series: [{kind:'population' as const}] };
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
  it('uses top-five plus exact Other queries and preserves the dashboard total', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = { ...state, catalog: {
      ...getAuthoredCatalog(),
      fieldValues: { manufacturer: { bold: { k4plus: Array.from({ length: 8 }, (_, i) => ({ value: `Vendor${i}`, n: 80 - i })) } } },
    } as unknown as CompletedCatalog };
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean'),form:'band',series:[{kind:'field',field:asColumnId('manufacturer')}] } });
    const panel = state.panels[4];
    const queries=panelQueries(state,panel);
    expect(queries).toHaveLength(7);
    expect(queries[5]).toMatchObject({proc:'timeSummary',filters:[{field:'manufacturer',op:'in',values:['Vendor5','Vendor6','Vendor7']}]});
    state={...state,dataVersion:'v',datasets:Object.fromEntries(queries.map((query,i)=>[queryKey(query),{status:'ready' as const,version:'v',result:{buckets:[bucket('2024-01-01',null,i===5?6:i,i===6?612:i===5?222:80-i)]}}]))};
    const view = timePanelView(state, panel, LIGHT_THEME);
    expect(view.analysisRows).toHaveLength(6);
    expect(view.analysisRows?.at(-1)).toMatchObject({ name: 'Other', color: OTHER_COLOR, cells: ['222', '6', '6', '0'] });
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
