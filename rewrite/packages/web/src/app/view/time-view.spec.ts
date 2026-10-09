import { queryKey } from '../api/api';
import { asColumnId, getAuthoredCatalog, type CompletedCatalog, type BinnedSummaryQuery, type BinnedSummaryResult } from '@mriqc/shared';
import { defaultDashboard, reduce } from '../graph/reducer';
import { panelQueries, timeTailQuery } from '../graph/queries';
import { INITIAL_STATE } from '../graph/state';
import { LIGHT_THEME, OTHER_COLOR } from '../panels/specs/palette';
import { timePanelView, timeSeriesStats } from './time-view';
import { approximateTimeTail } from './time-tail';
import { compile } from 'vega-lite';
import { panelView } from './panel-view';

const bucket = (start: string, group: string | null, median: number, n = 30) => ({ start, lo: (Date.parse(start) - Date.UTC(2000,0,1))/86400000, hi: (Date.parse(start) - Date.UTC(2000,0,1))/86400000+31, group, n, isOther: false, thin: n < 20, mean: median,
  quantiles: { p05: median, p25: median, p50: median, p75: median, p95: median } });
const query: BinnedSummaryQuery = { source: 'population', proc: 'binnedSummary', modality: 'bold', view: 'k4plus', filters: [], selections: [], x: asColumnId("created_at"), y: asColumnId('fd_mean'), groups: asColumnId('manufacturer'), bins: 'month' };

describe('time-summary projection', () => {
  it.each(['band', 'lines'] as const)('names the selected quantiles in %s stats and meaning', form => {
    for (const x of ['created_at', 'fd_mean']) {
      for (const quantiles of ['quartiles', 'tails'] as const) {
        let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
        state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { x: asColumnId(x), y: asColumnId('tsnr'), form: 'band', options: { quantiles, fill: form } } });
        const panel = state.panels[0];
        const result = { xKind: x === 'created_at' ? 'time' : 'metric', yKind: 'metric' as const, range: [0, 10000], buckets: [
          { ...bucket('2024-01-01', null, 3), quantiles: { p05: 1, p25: 2, p50: 3, p75: 4, p95: 5 } },
        ] };
        const summary = { n: 30, min: 1, max: 5, mean: 3, stddev: 1, quantiles: { p01: 1, p05: 1, p25: 2, p50: 3, p75: 4, p95: 5, p99: 5 }, histogram: { lo: 1, hi: 5, width: 1, counts: [5, 10, 10, 5] } };
        state = { ...state, datasets: Object.fromEntries(panelQueries(state, panel).map(query => [queryKey(query), { status: 'ready' as const, version: 'v', result: query.proc === 'distribution' ? summary : result }])) };
        const view = panelView(state, 'p1')!;
        expect(view.title).toBe(x === 'created_at' ? 'tSNR over time' : 'tSNR vs FD mean');
        const [lower, upper] = quantiles === 'quartiles' ? ['Q1', 'Q3'] : ['p05', 'p95'];
        expect(view.analysisRows).toEqual([]);
        expect(view.stats?.find(stat => stat.label === 'MEDIAN')?.value).toBe('3');
        expect(view.stats?.find(stat => stat.label === '5TH PCT')?.value).toBe('1');
        expect(view.meaning).toContain(lower);
        expect(view.meaning).toContain(upper);
      }
    }
  });

  it.each(['band', 'lines'] as const)('dispatches %s through time summaries and its own marks', form => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'setPanelAxis', id: 'p5', axis: 'y', value: asColumnId('fd_mean') });
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { form: 'band', options: { fill: form } } });
    const panel = state.panels[4];
    const queries = panelQueries(state, panel);
    expect(queries.map(query => query.proc)).toEqual(['binnedSummary', 'distribution']);
    const datasets = Object.fromEntries(queries.filter(query => query.proc === 'binnedSummary').map(query => [queryKey(query), {
      status: 'ready' as const, version: 'v', result: { xKind: "time" as const, yKind: 'metric' as const, range: [0,10000] as [number,number], buckets: [bucket('2024-01-01', null, 0.3)] },
    }]));
    const view = panelView({ ...state, dataVersion: 'v', datasets }, 'p5')!;
    expect(view.hasRows).toBe(true);
    expect(JSON.stringify(view.spec)).toContain(form === 'band' ? '"area"' : 'p25');
    expect(JSON.stringify(view.spec)).not.toContain('"type":"bar"');
    expect(() => compile(view.spec!)).not.toThrow();
  });
  it('suppresses the cohort colour legend only when cohort chips name the series', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean'), form:'band', series: [] } });
    const panel = { ...state.panels[4], series: [{kind:'population' as const}] };
    state = { ...state, panels: [panel] };
    const datasets = Object.fromEntries(panelQueries(state, panel).map(query => [queryKey(query), {
      status: 'ready' as const, version: 'v', result: { xKind: "time" as const, yKind: 'metric' as const, range: [0,10000] as [number,number], buckets: [bucket('2024-01-01', null, 0.3)] },
    }]));
    const view = timePanelView({ ...state, dataVersion: 'v', datasets }, panel, LIGHT_THEME);
    expect(view.cohorts).toHaveLength(2);
    expect(JSON.stringify(compile(view.spec!).spec)).not.toContain('"legends":');
  });
  it('reports total n, chronological first/last medians and signed change', () => {
    expect(timeSeriesStats({ id: 'a', name: 'A', color: '', result: { xKind: "time" as const, yKind: 'metric' as const, range: [0,10000] as [number,number], buckets: [bucket('2024-02-01', null, 0.8), bucket('2024-01-01', null, 0.3, 10)] } }))
      .toEqual({ n: 40, first: 0.3, last: 0.8, change: 0.5, firstDate: '2024-01-01', lastDate: '2024-02-01' });
  });
  it('queries the categorical tail together for exact Other quantiles', () => {
    const result: BinnedSummaryResult = { xKind: "time", yKind: 'metric' as const, range: [0,10000], buckets: Array.from({ length: 8 }, (_, i) => bucket('2024-01-01', `Vendor${i}`, i, 80 - i)) };
    expect(timeTailQuery(query, result)).toEqual({ ...query, groups: undefined,
      filters: [{ field: query.groups, op: 'in', values: ['Vendor6', 'Vendor7'] }] });
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
    expect(queries.filter(query => query.proc === 'binnedSummary')).toHaveLength(7);
    expect(queries[5]).toMatchObject({proc:'binnedSummary',filters:[{field:'manufacturer',op:'in',values:['Vendor5','Vendor6','Vendor7']}]});
    state={...state,dataVersion:'v',datasets:Object.fromEntries(queries.filter(query => query.proc === 'binnedSummary').map((query,i)=>[queryKey(query),{status:'ready' as const,version:'v',result:{xKind:'time',yKind:'metric',range:[0,10000],buckets:[bucket('2024-01-01',null,i===5?6:i,i===6?612:i===5?222:80-i)]}}]))};
    const view = timePanelView(state, panel, LIGHT_THEME);
    expect(view.analysisRows).toHaveLength(6);
    expect(view.analysisRows?.at(-1)).toMatchObject({ name: 'Other', color: OTHER_COLOR, cells: ['222', '6', '6', '6', '6', '6', '6', '0'] });
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
