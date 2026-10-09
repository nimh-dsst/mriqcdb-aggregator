import { queryKey } from '../api/api';
import { asColumnId, type DistributionResult } from '@mriqc/shared';
import { defaultDashboard, initialState, reduce } from './reducer';
import { defaultPanelOptions, FIRST_PAGE, type Panel, type State } from './state';
import { decodeUrlState, encodeUrlState, validateUrlState } from './url';
import { readUrlRecord, writeUrlRecord } from './url-fields';
import { panelQueries, panelSharedRange } from './queries';
import { axisEvidence } from './axis-options';
import { stackedRows, stackedHistogram } from '../panels/specs/comparison';
import { valueScale } from '../panels/specs/palette';
import { withCountRange } from '../panels/specs/axis-ranges';
import { distributionBins } from '../panels/specs/rows';
import { panelView, resetPanelViewMemo } from '../view/panel-view';

const panel = (): Panel => ({ ...defaultDashboard().panels[0], options: defaultPanelOptions(), cursors: FIRST_PAGE });
const state = (p = panel()): State => ({ ...initialState, panels: [p], dataVersion: 'v1' });
const dist = (counts: number[]): DistributionResult => ({ n: counts.reduce((a,b)=>a+b,0), min: 1, max: 3, mean: 2, stddev: 1,
  quantiles: {p01:1,p05:1,p25:1.5,p50:2,p75:2.5,p95:3,p99:3}, histogram: {lo:1,hi:3,width:1,counts} });

describe('axes, layout and size state', () => {
  it('automatically switches density to histogram without a global notice', () => {
    const p = {...panel(), series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form:'density' as const};
    const result = reduce(state(p), {t:'setPanelOptions',id:p.id,options:{xScale:'symlog',xRange:[10,-2],layout:'stacked100'}});
    expect(result.panels[0].options).toMatchObject({xScale:'symlog',xRange:[-2,10],layout:'stacked100'});
    expect(result.panels[0].form).toBe('histogram');
    expect(result.notice).toBeNull();
  });
  it('rejects stacking overlapping cohorts and nonfinite ranges', () => {
    const p = {...panel(),series:[{kind:'population' as const}]};
    const result=reduce(state(p),{t:'setPanelOptions',id:p.id,options:{layout:'stacked',xRange:[0,Infinity]}});
    expect(result.panels[0].options).toMatchObject({layout:'overlaid',xRange:'auto'});
  });
  it.each(['stacked', 'stacked100'] as const)('uses the unsplit clipped histogram extent for %s', (layout) => {
    const p = { ...panel(), series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'histogram' as const,
      options: { ...defaultPanelOptions(), layout } };
    const s = state(p);
    const unsplit = { ...p, series: [] };
    const query = panelQueries(s, unsplit)[0];
    s.datasets = { [queryKey(query)]: { status: 'ready', version: 'v1', result: dist([2, 3]) } };
    expect(panelSharedRange(s, p, [])).toEqual([1, 3]);
    expect(panelSharedRange(s, { ...p, options: { ...p.options, xRange: [1.5, 2.5] } }, [])).toEqual([1.5, 2.5]);
  });
  it('round-trips options with three significant digits for shared ranges', () => {
    const p={...panel(),series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],options:{...defaultPanelOptions(),xScale:'log' as const,xRange:[0.01234567,10] as const,yScale:'symlog' as const,yRange:[-5,5] as const,yMode:'share' as const,layout:'stacked100' as const}};
    const url={...defaultDashboard(),panels:[p]};
    expect(decodeUrlState(encodeUrlState(url))?.panels[0].options).toEqual({...p.options, xRange: [0.0123, 10]});
  });
  it('omits defaults and round-trips the stream scale flag', () => {
    const original=defaultDashboard();
    const record=writeUrlRecord(original);
    expect(record).toBe('');
    const modern=writeUrlRecord({...original,panels:[{...panel(),options:{...defaultPanelOptions(),xScale:'log'}}]});
    expect(readUrlRecord(modern)?.panels[0].options.xScale).toBe('log');
  });
  it('sends a custom single-series range to distribution', () => {
    const p=panel(); p.options.xRange=[0.05,0.5];
    expect(panelQueries(state(p),p)[0]).toMatchObject({range:[0.05,0.5]});
  });
  it('renders every server-rebinned bin, including bins beyond the old clip quantiles', () => {
    const p = panel(); p.options.xRange = [0.1, 0.6];
    const s = state(p);
    const result = { ...dist([2, 3]), histogram: { lo: 0.1, hi: 0.6, width: 0.05, counts: [2, 1, 2, 3, 2, 1, 3, 2, 1, 2] } };
    const query = panelQueries(s, p)[0];
    expect(query).toMatchObject({ range: [0.1, 0.6] });
    s.datasets = { [queryKey(query)]: { status: 'ready', version: 'v1', result } };
    resetPanelViewMemo();
    const rows = Object.values(panelView(s, p.id)!.datasets).flat() as { lo: number; hi: number }[];
    expect(rows).toHaveLength(result.histogram.counts.length);
    expect(rows[0].lo).toBe(0.1);
    expect(rows.at(-1)!.hi).toBeCloseTo(0.6, 12);
    expect(rows).toEqual(distributionBins(result));
  });
  it('uses one exact custom range for every cohort in the two-step plan', () => {
    const p={...panel(),series:[{kind:'population' as const}]}; p.options.xRange=[0.1,0.8];
    const queries=panelQueries(state(p),p);
    expect(queries).toHaveLength(4);
    expect(queries.slice(2).every(q=>'range' in q && JSON.stringify(q.range)==='[0.1,0.8]')).toBe(true);
  });
  it('sends temporal axis bounds to the server as UTC filters', () => {
    const p = { ...panel(), x: 'created_at' as const };
    p.options.xRange = [Date.parse('2024-01-01'), Date.parse('2024-05-01')];
    expect(panelQueries(state(p), p)[0]).toMatchObject({ proc: 'coverage', filters: [
      { field: 'created_at', op: 'between', lo: '2024-01-01T00:00:00.000Z', hi: '2024-05-01T00:00:00.000Z' },
    ] });
  });
  it('uses the count range while preserving a logarithmic count scale', () => {
    const p = panel(); p.options.yRange = [5, 100]; p.options.yMode = 'logCount';
    const spec = { data: { name: 'counts' }, mark: 'bar' as const, encoding: { y: { field: 'count', type: 'quantitative' as const, scale: { type: 'log' as const } } } };
    expect(withCountRange(spec, p)).toMatchObject({ encoding: { y: { scale: { type: 'log', domain: [5, 100], nice: false, zero: false } } } });
    expect(spec.encoding.y.scale).toEqual({ type: 'log' });
  });
  it('allows log only when the known minimum is positive', () => {
    const p=panel(), s=state(p), key=queryKey(panelQueries(s,p)[0]);
    expect(axisEvidence(s,p).positive).toBe(false);
    s.datasets={[key]:{status:'ready',version:'v1',result:dist([2,3])}};
    expect(axisEvidence(s,p)).toEqual({positive:true,constant:1});
    s.datasets={[key]:{status:'ready',version:'v1',result:{...dist([2,3]),min:0}}};
    expect(axisEvidence(s,p).positive).toBe(false);
  });
  it('builds log and symlog scales with the exact custom domain', () => {
    expect(valueScale('log',[1,10])).toMatchObject({type:'log',domain:[1,10]});
    expect(valueScale('symlog',[-3,3],0.2)).toMatchObject({type:'symlog',constant:0.2,domain:[-3,3]});
  });
});

describe('stack bins and plain grid rows', () => {
  const results=[{id:'a',name:'A',base:dist([2,3]),ranged:dist([2,3])},{id:'b',name:'B',base:dist([6,1]),ranged:dist([6,1])}];
  it.each([false, true])('keeps stacked marks free of direct labels with a visible top legend (normalized=%s)', (normalized) => {
    const { spec } = stackedHistogram({ label: 'Metric', logScale: false, countTitle: 'Scans' },
      [{ id: 'a', label: 'A', color: '#0072B2' }, { id: 'b', label: 'B', color: '#009E73' }], results, normalized);
    expect(spec).toMatchObject({ mark: { type: 'bar' }, encoding: {
      color: { legend: { orient: 'top', symbolType: 'square' } },
      y: { title: normalized ? 'Share of bin' : 'Scans' },
    } });
    expect(spec).not.toHaveProperty('layer');
  });
  it('preserves each series count and stacks in legend order', () => {
    const rows=stackedRows(results,['b','a'],false);
    expect(rows.filter(r=>r.cohort==='a').reduce((sum,r)=>sum+r.count,0)).toBe(5);
    expect(rows.filter(r=>r.cohort==='b').reduce((sum,r)=>sum+r.count,0)).toBe(7);
    expect(rows[0]).toMatchObject({cohort:'b',y0:0,y1:6});
    expect(rows[1]).toMatchObject({cohort:'a',y0:6,y1:8});
  });
  it('normalizes each occupied bin to exactly 100%', () => {
    const rows=stackedRows(results,['a','b'],true);
    for(const lo of [1,2]) expect(rows.filter(r=>r.lo===lo).reduce((sum,r)=>sum+r.share,0)).toBeCloseTo(1);
    expect(rows.filter(r=>r.cohort==='b').every(r=>r.y1===1)).toBe(true);
  });
  it('renders stack bars with series, bin, count and share tooltips', () => {
    const output=stackedHistogram({label:'Metric',logScale:false,countTitle:'Scans'},[{id:'a',label:'A',color:'#0072B2'},{id:'b',label:'B',color:'#009E73'}],results,true);
    expect(output.rows).toHaveLength(4);
    expect(JSON.stringify(output.spec)).toContain('y0');
    expect(JSON.stringify(output.spec)).toContain('share');
  });
});
