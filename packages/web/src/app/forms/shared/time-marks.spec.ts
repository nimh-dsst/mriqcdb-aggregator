import { describe, expect, it } from 'vitest';
import { compile } from 'vega-lite';
import { continuousChart } from './continuous';
import { bandChart, type BinnedSeries } from '../band/band';
import { densityChart, clustersChart } from '../heatmap/analysis-charts';
import { defaultPanelOptions } from '../../graph/state';
import type { ChartInput } from './select';
import type { Density2dResult } from '@mriqc/shared';

const input: ChartInput = { form: 'histogram', axis: { label: 'Upload time', xScale: 'time', granularity: 'month', logScale: false, countTitle: 'Uploads' },
  clip: 'none', brush: null, groupLabel: 'Series', groupField: null, groupOrdered: false, cohortLabel: 'A', granularity: 'month',
  options: defaultPanelOptions(), result: null, cohorts: [{ id: 'a', label: 'A', color: '#000' }], cohortResults: [] };
const coverage = { buckets: [{ start: '2024-01-01', group: null, n: 1 }, { start: '2024-03-01', group: null, n: 3 }] };
const summary: BinnedSeries[] = [{ id: 'a', name: 'A', color: '#000', result: { xKind: 'time', yKind: 'metric', range: [8766, 8826], buckets: [
  { lo: 8766, hi: 8797, start: '2024-01-01', group: null, n: 30, isOther: false, thin: false, mean: 2, quantiles: { p05: 0, p25: 1, p50: 2, p75: 3, p95: 4 } },
  { lo: 8797, hi: 8826, start: '2024-02-01', group: null, n: 10, isOther: false, thin: true, mean: 3, quantiles: { p05: 1, p25: 2, p50: 3, p75: 4, p95: 5 } },
] } }];

describe('time marks', () => {
  it.each(['band', 'lines'] as const)('draws both quantile settings for %s on numeric and time x', form => {
    for (const xKind of ['metric', 'time'] as const) {
      for (const quantiles of ['quartiles', 'tails'] as const) {
        const chart = bandChart(summary.map(series => ({ ...series, result: { ...series.result, xKind } })),
          'tSNR', { ...input.axis, xScale: xKind === 'time' ? 'time' : 'linear' }, form, quantiles);
        expect(() => compile(chart.spec)).not.toThrow();
        const layers = (chart.spec as any).layer;
        const [lo, hi] = quantiles === 'quartiles' ? ['p25', 'p75'] : ['p05', 'p95'];
        const names = quantiles === 'quartiles' ? ['Q1', 'Median', 'Q3'] : ['p05', 'Median', 'p95'];
        expect(layers[0].encoding.tooltip.filter((item: any) => /^p\d+$/.test(item.field))).toEqual([
          { field: lo, type: 'quantitative', title: names[0] },
          { field: 'p50', type: 'quantitative', title: names[1] },
          { field: hi, type: 'quantitative', title: names[2] },
        ]);
        if (form === 'band') {
          expect(layers[0].encoding).toMatchObject({ y: { field: lo }, y2: { field: hi } });
          expect(layers[1].encoding.y.field).toBe('p50');
        } else {
          expect(chart.datasets['percentileLines'].slice(0, 3)).toMatchObject(names.map((percentile, index) => ({
            percentile, value: quantiles === 'quartiles' ? [1, 2, 3][index] : [0, 2, 4][index],
          })));
          expect(chart.datasets['percentileLines']).toHaveLength(6);
        }
      }
    }
  });

  it.each(['histogram', 'line', 'area', 'density', 'ecdf', 'box'] as const)('uses the common %s builder with a date axis', form => {
    const chart = continuousChart({ ...input, form }, [coverage]);
    expect(() => compile(chart.spec!)).not.toThrow();
    expect(JSON.stringify(chart.spec)).toContain('"type":"temporal"');
    expect(JSON.stringify(chart.spec)).toContain('"type":"utc"');
    expect(JSON.stringify(chart.spec)).toContain('%b %Y');
    expect(chart.n).toBe(4);
  });
  it('uses calendar month bounds, fills February, and ends the cumulative share at 100%', () => {
    const histogram = continuousChart(input, [coverage]);
    expect(histogram.datasets['population']).toMatchObject([
      { lo: Date.UTC(2024, 0, 1), hi: Date.UTC(2024, 1, 1), count: 1 },
      { lo: Date.UTC(2024, 1, 1), hi: Date.UTC(2024, 2, 1), count: 0 },
      { lo: Date.UTC(2024, 2, 1), hi: Date.UTC(2024, 3, 1), count: 3 },
    ]);
    const compiled = compile(histogram.spec!).spec;
    const marks = compiled.marks as any[];
    const bars = marks.find(mark => mark.type === 'rect');
    expect(bars.encode.update.y2).toMatchObject({ scale: 'y', field: 'count_start' });
    expect((compiled.data as any[]).flatMap(source => source.transform ?? []).some(transform => transform.type === 'stack' && transform.offset === 'zero')).toBe(true);
    const ecdf = continuousChart({ ...input, form: 'ecdf' }, [coverage]);
    expect(ecdf.datasets['population'].map(row => (row as {p:number}).p)).toEqual([0, 0.25, 0.25, 1]);
    const box = continuousChart({ ...input, form: 'box' }, [coverage]);
    expect(box.datasets['groups'][0]).toMatchObject({ p50: (Date.UTC(2024, 2, 1) + Date.UTC(2024, 3, 1)) / 2, note: 'from monthly counts' });
    expect(JSON.stringify(box.spec)).toContain('Approximation');
  });
  it('normalizes Area with series and leaves a single Area as counts', () => {
    const multiple = continuousChart({ ...input, form: 'area', cohorts: [...input.cohorts, { id:'b', label:'B',color:'#fff' }] }, [coverage, coverage]);
    const single = continuousChart({ ...input, form: 'area' }, [coverage]);
    expect(multiple.spec).toMatchObject({ encoding: { y: { stack: 'normalize', axis: { format: '.0%' } } } });
    expect(single.spec).toMatchObject({ encoding: { y: { stack: null, title: 'Uploads' } } });
  });
  it('aligns calendar series whose first occupied months differ', () => {
    const chart = continuousChart({ ...input, form: 'area', cohorts: [...input.cohorts, { id:'b',label:'B',color:'#fff' }] },
      [coverage, {buckets:[{start:'2024-03-01',group:null,n:2}]}]);
    const rows=chart.datasets['counts'] as {cohort:string;lo:number;count:number}[];
    expect(rows.filter(row=>row.cohort==='b').map(row=>row.count)).toEqual([0,0,2]);
    expect(rows.filter(row=>row.cohort==='a').map(row=>row.lo)).toEqual(rows.filter(row=>row.cohort==='b').map(row=>row.lo));
  });
  it.each(['band', 'lines'] as const)('renders %s across calendar months or numeric bins', form => {
    const time = bandChart(summary, 'tSNR', input.axis, form);
    expect(() => compile(time.spec)).not.toThrow();
    expect(JSON.stringify(time.spec)).toContain('"type":"temporal"');
    const numeric = bandChart(summary.map(s => ({...s,result:{...s.result,xKind:'metric'}})), 'tSNR', { ...input.axis, label:'FD mean',xScale:'linear' }, form);
    expect(() => compile(numeric.spec)).not.toThrow();
    expect(JSON.stringify(numeric.spec)).not.toContain('"type":"temporal"');
    expect(numeric.datasets['binnedSummary'][0]).toMatchObject({bucket: (8766+8797)/2});
    expect(numeric.datasets['binnedSummarySegments']).toHaveLength(2);
    expect(numeric.datasets['binnedSummarySegments'][0]).toMatchObject({segmentThin:true});
  });
  const paired: Density2dResult = { xKind:'time',yKind:'metric',x:{lo:8766,width:31,bins:1,underflow:0,overflow:0},y:{lo:0,width:1,bins:1,underflow:0,overflow:0}, counts:[2],n:2,pearson:null,spearman:null,sample:[[8766,0.2],[8790,0.8]] };
  it.each(['heatmap','scatter','hexbin'] as const)('renders %s time x from epoch days', form => {
    const chart = densityChart([{id:'a',name:'A',color:'#000',result:paired}], {xLabel:'Upload time',yLabel:'tSNR',xScale:{type:'utc'},form,showPoints:true});
    expect(() => compile(chart.spec)).not.toThrow();
    expect(JSON.stringify(chart.spec)).toContain('"type":"temporal"');
    expect(JSON.stringify(chart.datasets)).toContain(String(Date.UTC(2024,0,1)));
  });
  it('renders Clusters over dates without changing cluster assignments', () => {
    const chart=clustersChart(paired.sample,{assignments:[0,0],centroids:[[8766,0.5]],clusters:[],silhouette:0},'Upload time','tSNR',undefined,'time');
    expect(() => compile(chart.spec)).not.toThrow();
    expect(chart.datasets['cluster-points'][0]).toMatchObject({x:Date.UTC(2024,0,1),clusterId:0});
  });
});
