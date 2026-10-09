import { asColumnId, getAuthoredCatalog, queryKey, type CompletedCatalog } from '@mriqc/shared';
import { initialState, reduce } from './reducer';
import { chartsFor, defaultChartFor, shapeOf } from './panel-shapes';
import { panelQueries } from './queries';
import { defaultPanelOptions, type Panel, type State } from './state';
import { decodeUrlState, encodeUrlState, urlState, validateUrlState } from './url';
import { panelView } from '../view/panel-view';

const metric = asColumnId('fd_mean'), second = asColumnId('tsnr');
function panel(patch: Partial<Panel> = {}): Panel {
  return { id: 'p1', x: metric, y: null, split: null, cohorts: ['current'], chart: 'histogram', options: defaultPanelOptions(), cursors: [null], ...patch };
}
function state(patch: Partial<Panel> = {}): State {
  return { ...initialState, dataVersion: 'v1', global: { modality: 'bold', view: 'raw', filters: [] },
    catalog: { ...getAuthoredCatalog(), fieldValues: {}, numericRange: {}, dateRange: {}, metricCounts: {}, availableViews: {} } as unknown as CompletedCatalog,
    panels: [panel(patch)] };
}
describe('analysis axes', () => {
  it('preserves chart, split and a single cohort binding through face commands and a URL round trip', () => {
    let next = reduce(state(), { t: 'setPanelCohort', id: 'p1', cohort: 'all' });
    next = reduce(next, { t: 'setPanelSplit', id: 'p1', split: asColumnId('manufacturer') });
    expect(next.panels[0]).toMatchObject({ chart: 'density', cohorts: ['all'], split: 'manufacturer' });
    next = reduce(next, { t: 'setPanelChart', id: 'p1', chart: 'ecdf' });
    // Split ECDF is the existing faceted form; an invalid chart keeps the shape default.
    expect(next.panels[0].chart).toBe('density');
    next = reduce(next, { t: 'setPanelSplit', id: 'p1', split: null });
    next = reduce(next, { t: 'setPanelChart', id: 'p1', chart: 'ecdf' });
    expect(next.panels[0]).toMatchObject({ chart: 'ecdf', cohorts: ['all'], split: null });
    const url = urlState(next);
    expect(decodeUrlState(encodeUrlState(url))).toEqual(url);
  });
  it.each([
    [{}, 'distribution', 'histogram'],
    [{ split: asColumnId('manufacturer') }, 'grouped', 'density'],
    [{ cohorts: ['current', 'all'] }, 'comparison', 'density'],
    [{ x: 'created_at' }, 'coverage', 'stackedBar'],
    [{ y: second }, 'bivariate', 'density2d'],
  ] as const)('derives the shape and default from %j', (axes, shape, chart) => {
    expect(shapeOf(panel(axes))).toBe(shape);
    expect(defaultChartFor(shape)).toBe(chart);
    expect(chartsFor(shape)).toContain(chart);
  });
  it('adding and clearing y changes invalid charts to the axis default', () => {
    const paired = reduce(state(), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: second });
    expect(paired.panels[0].chart).toBe('density2d');
    expect('kind' in paired.panels[0]).toBe(false);
    const single = reduce(paired, { t: 'setPanelAxis', id: 'p1', axis: 'y', value: null });
    expect(single.panels[0].chart).toBe('histogram');
  });
  it('refuses the same metric twice and a split across multiple cohorts', () => {
    const same = reduce(state(), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: metric });
    expect(same.panels[0].y).toBeNull(); expect(same.notice).toContain('different');
    const split = reduce(state({ cohorts: ['current','all'] }), { t: 'setPanelSplit', id: 'p1', split: asColumnId('manufacturer') });
    expect(split.panels[0].split).toBeNull(); expect(split.notice).toContain('multiple cohorts');
  });
  it('can leave Table for a chart allowed by its axes', () => {
    const next = reduce(state({ chart: 'table', y: second }), { t: 'setPanelChart', id: 'p1', chart: 'density2d' });
    expect(next.panels[0].chart).toBe('density2d');
  });
  it('defaults a metric over upload time to its median band', () => {
    const next = reduce(state({ x: 'created_at', chart: 'stackedBar' }), { t: 'setPanelAxis', id: 'p1', axis: 'y', value: second });
    expect(next.panels[0].y).toBe('tsnr'); expect(next.panels[0].chart).toBe('medianBand');
  });
  it.each(['density2d','scatter','hexbin','clusters'] as const)('round-trips %s and seeded options', chart => {
    const source = urlState(state({ y: second, chart, options: { ...defaultPanelOptions(), k: 3, seed: 19, sampleSize: 20000, showPoints: true } }));
    expect(decodeUrlState(encodeUrlState(source))).toEqual(source);
  });
  it('round-trips a custom correlation set and a time-axis table', () => {
    for (const p of [panel({ chart: 'correlation', options: { ...defaultPanelOptions(), family: 'custom', metrics: [metric,second], clusterOrder: true } }), panel({ x: 'created_at', chart: 'table' })]) {
      const source = urlState({ ...state(), panels: [p] });
      expect(decodeUrlState(encodeUrlState(source))).toEqual(source);
    }
  });
  it('requests a 20k density sample for clusters, and both correlation methods', () => {
    const clusters = state({ y: second, chart: 'clusters' });
    expect(panelQueries(clusters, clusters.panels[0])[0]).toMatchObject({ proc: 'density2d', sampleSize: 20000, seed: 42, x: metric, y: second });
    const matrix = state({ chart: 'correlation' });
    expect(panelQueries(matrix,matrix.panels[0])[0]).toMatchObject({ proc: 'correlation', method: 'both', metrics: ['fd_mean','dvars_std','tsnr','snr','efc','fber','gsr_x','aor'] });
  });
  it('renders correlation results without reading them as density coefficients', () => {
    const s = state({ chart: 'correlation' });
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
    const s = state({ chart: 'correlation', cohorts: ['study'], options: {...defaultPanelOptions(),family:'Motion'} });
    s.study = { status: 'ready', name: 'local.csv', rows: 10, metrics: [metric,asColumnId('fd_num')], totalMetrics: 2, ignoredColumns: [], missingMetrics: [] };
    expect(panelQueries(s,s.panels[0])[0]).toMatchObject({ source: 'study', metrics: [metric,'fd_num'] });
  });
  it('normalizes invalid URL axes to available metrics', () => {
    const source = urlState(state());
    const valid = validateUrlState({ ...source, global: { ...source.global, modality: 'T1w' } });
    expect(valid.panels[0].x).not.toBe(metric);
    expect(valid.panels[0].cohorts).toEqual(['current']);
  });
});
