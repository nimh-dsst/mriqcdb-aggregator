import { queryKey } from '../api/api';
import { asColumnId, getAuthoredCatalog, type CompletedCatalog } from '@mriqc/shared';
import { initialState, reduce } from './reducer';
import { formsFor } from './panel-shapes';
import { panelQueries } from './queries';
import { defaultPanelOptions, type Panel, type State } from './state';
import { decodeUrlState, encodeUrlState, urlState, validateUrlState } from './url';
import { panelView } from '../view/panel-view';

const metric = asColumnId('fd_mean'), second = asColumnId('tsnr');
function panel(patch: Partial<Panel> = {}): Panel {
  return { id: 'p1', x: metric, y: null, series: [],  form: 'histogram', options: defaultPanelOptions(), cursors: [null], ...patch };
}
function state(patch: Partial<Panel> = {}): State {
  return { ...initialState, dataVersion: 'v1', global: { modality: 'bold', view: 'raw', filters: [] },
    catalog: { ...getAuthoredCatalog(), fieldValues: {}, numericRange: {}, dateRange: {}, metricCounts: {}, availableViews: {} } as unknown as CompletedCatalog,
    panels: [panel(patch)] };
}
describe('analysis axes', () => {
  it('preserves form while adding values and population through a URL round trip', () => {
    let next = reduce(state(), { t: 'addPanelSeries', id: 'p1', series: { kind: 'population' } });
    next = reduce(next, { t: 'addPanelSeries', id: 'p1', series: { kind: 'values', field: asColumnId('manufacturer'), values: ['Siemens', 'GE'] } });
    expect(next.panels[0].form).toBe('histogram');
    next = reduce(next, { t: 'setPanelChart', id: 'p1', form: 'ecdf' });
    expect(next.panels[0].form).toBe('ecdf');
    expect(next.panels[0].series).toHaveLength(2);
    const url = urlState(next);
    expect(decodeUrlState(encodeUrlState(url))).toEqual(url);
  });
  it.each([
    [{}, 'histogram'],
    [{ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] }, 'histogram'],
    [{ series: [{kind:'population' as const}] }, 'histogram'],
    [{ x: 'created_at' }, 'histogram'],
    [{ y: second }, 'heatmap'],
  ] as const)('derives the default from axes %j', (axes, form) => {
    const p = panel(axes);
    expect(formsFor(p.x, p.y)[0]).toBe(form);
  });
  it('adding and clearing y changes invalid charts to the axis default', () => {
    const paired = reduce(state(), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: second });
    expect(paired.panels[0].form).toBe('heatmap');
    expect('kind' in paired.panels[0]).toBe(false);
    const single = reduce(paired, { t: 'setPanelAxis', id: 'p1', axis: 'y', value: null });
    expect(single.panels[0].form).toBe('histogram');
  });
  it('refuses the same metric twice and adding above the series cap', () => {
    const same = reduce(state(), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: metric });
    expect(same.panels[0].y).toBeNull(); expect(same.notice).toContain('different');
    const split = reduce(state({ series: [{ kind: 'population' as const }] }), { t: 'addPanelSeries', id: 'p1', series: { kind: 'field', field: asColumnId('manufacturer') } });
    expect(split.panels[0].series).toEqual([{kind:'population'}]); expect(split.notice).toContain('Six');
  });
  it('can leave Table for a chart allowed by its axes', () => {
    const next = reduce(state({ form: 'table', y: second }), { t: 'setPanelChart', id: 'p1', form: 'heatmap' });
    expect(next.panels[0].form).toBe('heatmap');
  });
  it('switches time counts to Band when a metric is chosen', () => {
    const next = reduce(state({ x: 'created_at', form: 'histogram' }), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: second });
    expect(next.panels[0].y).toBe('tsnr'); expect(next.panels[0].form).toBe('band');
  });
  it.each(['heatmap','scatter','clusters'] as const)('round-trips %s and seeded options', chart => {
    const source = urlState(state({ y: second, form: chart, options: { ...defaultPanelOptions(), k: 3, seed: 19, sampleSize: 20000, showPoints: true } }));
    expect(decodeUrlState(encodeUrlState(source))).toEqual(source);
  });
  it('round-trips a custom correlation set and a time-axis line', () => {
    for (const p of [panel({ form: 'matrix', options: { ...defaultPanelOptions(), family: 'custom', metrics: [metric,second], clusterOrder: true } }), panel({ x: 'created_at', form: 'line' })]) {
      const source = urlState({ ...state(), panels: [p] });
      expect(decodeUrlState(encodeUrlState(source))).toEqual(source);
    }
  });
  it('requests a 20k density sample for clusters, and both correlation methods', () => {
    const clusters = state({ y: second, form: 'clusters' });
    expect(panelQueries(clusters, clusters.panels[0])[0]).toMatchObject({ proc: 'density2d', sampleSize: 20000, seed: 42, x: metric, y: second });
    const matrix = state({ form: 'matrix' });
    expect(panelQueries(matrix,matrix.panels[0])[0]).toMatchObject({ proc: 'correlation', method: 'both', metrics: ['fd_mean','dvars_std','tsnr','snr','efc','fber','gsr_x','aor'] });
  });
  it('renders correlation results without reading them as density coefficients', () => {
    const s = state({ form: 'matrix' });
    const query = panelQueries(s,s.panels[0])[0];
    const matrix = [[1,0.2],[0.2,1]];
    s.datasets = { [queryKey(query)]: { status: 'ready', version: 'v1', result: { metrics: [metric,second], pearson: matrix, spearman: matrix, pairN: [[20,20],[20,20]], minPairN: 20 } } };
    const v = panelView(s,'p1');
    expect(v?.title).toBe('Metric correlations');
    expect(v?.status.kind).toBe('ready');
    expect(v?.n).toBe(20);
    expect(v?.spec).not.toBeNull();
  });
  it('uses only available study columns for an automatic family', () => {
    const s = state({ form: 'matrix', series: [{ kind: 'study' as const }], options: {...defaultPanelOptions(),family:'Motion'} });
    s.study = { status: 'ready', name: 'local.csv', rows: 10, metrics: [metric,asColumnId('fd_num')], totalMetrics: 2, ignoredColumns: [], missingMetrics: [] };
    expect(panelQueries(s,s.panels[0]).find(q => 'source' in q && q.source === 'study')).toMatchObject({ source: 'study', metrics: [metric,'fd_num'] });
  });

  it('renders a matrix for every comparison, with one chip legend', () => {
    const s = state({ form: 'matrix', series: [{ kind: 'population' }] });
    const matrix = [[1, 0.2], [0.2, 1]];
    const data = { metrics: [metric, second], pearson: matrix, spearman: matrix, pairN: [[20, 20], [20, 20]], minPairN: 20 };
    s.datasets = Object.fromEntries(panelQueries(s, s.panels[0]).map(query => [queryKey(query), { status: 'ready', version: 'v1', result: data }]));
    const view = panelView(s, 'p1')!;
    expect(view.cohorts).toHaveLength(2);
    expect(view.cohorts?.map(cohort => cohort.n)).toEqual([20, 20]);
    expect((view.spec as { concat?: unknown[] }).concat).toHaveLength(2);
    expect(Object.keys(view.datasets)).toEqual(['correlation-cells-0', 'correlation-cells-1']);
  });
  it('normalizes invalid URL axes to available metrics', () => {
    const source = urlState(state());
    const valid = validateUrlState({ ...source, global: { ...source.global, modality: 'T1w' } });
    expect(valid.panels[0].x).not.toBe(metric);
    expect(valid.panels[0].series).toEqual([]);
  });
});
