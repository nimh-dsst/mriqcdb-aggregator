import { asColumnId } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';
import { compile } from 'vega-lite';
import { parse, View } from 'vega';
import { queryKey } from '../api/api';
import { INITIAL_STATE, defaultPanelOptions, type Panel, type State } from '../graph/state';
import { panelCohorts, panelQueries, studyFormReason } from '../graph/queries';
import { reduce } from '../graph/reducer';
import { panelView } from '../view/panel-view';

const fd = asColumnId('fd_mean'), tsnr = asColumnId('tsnr');
const panel = (patch: Partial<Panel> = {}): Panel => ({ id: 'study-test', x: fd, y: null, form: 'histogram',
  series: [{ kind: 'study' }], options: defaultPanelOptions(), cursors: [null], ...patch });
const state = (p: Panel): State => ({ ...INITIAL_STATE, global: { modality: 'bold', view: 'raw', filters: [] }, panels: [p],
  study: { status: 'ready', name: 'fixture.csv', rows: 300, metrics: [fd, tsnr], columns: ['bids_name', 'fd_mean', 'tsnr', 'manufacturer', 'created_at'],
    totalMetrics: 2, missingMetrics: [], ignoredColumns: [] } });

describe('study series across the scheme', () => {
  for (const form of ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table'] as const) {
    it(`plans local metric and time ${form}`, () => {
      for (const x of [fd, asColumnId('created_at')]) {
        const p = panel({ x, form }), s = state(p);
        expect(studyFormReason(p, s)).toBeNull();
        expect(panelCohorts(s, p).map(cohort => cohort.id)).toEqual(['current', 'study']);
        const queries = panelQueries(s, p).filter(query => query.source === 'study');
        expect(queries.some(query => query.proc === (form === 'table' ? 'sample' : x === fd ? 'distribution' : 'coverage'))).toBe(true);
      }
    });
  }
  for (const form of ['heatmap', 'scatter', 'clusters', 'band', 'lines'] as const) {
    it(`plans local two-axis ${form}`, () => {
      for (const x of [fd, asColumnId('created_at')]) {
        const p = panel({ x, y: tsnr, form }), s = state(p);
        expect(panelQueries(s, p).some(query => query.source === 'study' && query.proc ===
          (form === 'band' || form === 'lines' ? 'binnedSummary' : 'density2d'))).toBe(true);
      }
    });
  }
  for (const form of ['bars', 'share'] as const) {
    it(`counts all local category rows for ${form}`, () => {
      const p = panel({ x: asColumnId('manufacturer'), form }), s = state(p);
      expect(panelQueries(s, p).find(query => query.source === 'study' && query.proc === 'coverage')).toMatchObject({ countsOnly: true });
      expect(panelQueries(s, p).some(query => query.source === 'study' && query.proc === 'groupedSummary')).toBe(false);
    });
  }
  it('plans a study correlation matrix for the selected metrics', () => {
    const p = panel({ form: 'matrix', options: { ...defaultPanelOptions(), family: 'custom', metrics: [fd, tsnr] } });
    expect(panelQueries(state(p), p).find(query => query.source === 'study')).toMatchObject({ proc: 'correlation', metrics: [fd, tsnr] });
  });
  it('declares Vega-Lite on study Matrix small multiples so embed does not silently draw an empty Vega canvas', async () => {
    const p = panel({ form: 'matrix', options: { ...defaultPanelOptions(), family: 'custom', metrics: [fd, tsnr] } }), s = state(p);
    s.dataVersion = 'v';
    s.datasets = Object.fromEntries(panelQueries(s, p).map(query => [queryKey(query), { status: 'ready', version: 'v', result: {
      metrics: [fd, tsnr], pairN: [[300, 300], [300, 300]], minPairN: 300, pearson: [[1, .4], [.4, 1]], spearman: [[1, .3], [.3, 1]],
    } }]));
    const view = panelView(s, p.id)!;
    expect(view.spec?.$schema).toBe('https://vega.github.io/schema/vega-lite/v6.json');
    expect(Object.keys(view.datasets)).toHaveLength(2);
    expect(Object.values(view.datasets).every(rows => rows.length > 0)).toBe(true);
    const runtime = new View(parse(compile({ ...view.spec!, datasets: view.datasets }).spec), { renderer: 'none' });
    try {
      await runtime.runAsync();
      const cells: Array<{ width: number; height: number }> = [];
      const visit = (node: { mark?: { marktype?: string }; datum?: { value?: number }; width?: number; height?: number; items?: unknown[] }): void => {
        if (node.mark?.marktype === 'rect' && node.datum?.value !== undefined) cells.push({ width: node.width ?? 0, height: node.height ?? 0 });
        node.items?.forEach(item => visit(item as typeof node));
      };
      visit((runtime.scenegraph() as unknown as { root: Parameters<typeof visit>[0] }).root);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every(cell => cell.width > 10 && cell.height > 10)).toBe(true);
    } finally { runtime.finalize(); }
  });
  it('disables missing time or metric quantities without issuing a failing local query', () => {
    const p = panel({ x: 'created_at' }), s = state(p);
    s.study = { ...s.study as Extract<State['study'], { status: 'ready' }>, columns: ['fd_mean', 'tsnr'] };
    expect(studyFormReason(p, s)).toBe('your file has no upload time');
    expect(panelQueries(s, p).some(query => query.source === 'study')).toBe(false);
    expect(studyFormReason(panel({ y: asColumnId('snr'), form: 'heatmap' }), s)).toBe('your file has no snr column');
  });
  it('marks local Table rows with their series and includes uploaded metrics', () => {
    const p = panel({ form: 'table' }), s = state(p);
    s.dataVersion = 'v';
    s.datasets = Object.fromEntries(panelQueries(s, p).map(query => [queryKey(query), { status: 'ready', version: 'v', result:
      query.proc === 'sample' ? { rows: [{ bids_name: query.source, fd_mean: 0.2 }], nextCursor: null } : { n: 300 } }]));
    const view = panelView(s, p.id);
    expect(view?.table?.rows.find(row => row['__series'] === 'My study')).toMatchObject({ bids_name: 'study', fd_mean: 0.2 });
    expect(view?.table?.columns).toContain('fd_mean');
  });
  it('adds an upload only to compatible cards and respects an unchecked checkbox', () => {
    const numeric = panel({ series: [] }), time = panel({ id: 'time', x: 'created_at', series: [] });
    const s = { ...state(numeric), panels: [numeric, time], study: 'none' as const };
    const command = { t: 'studyLoaded' as const, name: 'fixture.csv', rows: 300, metrics: [fd, tsnr], columns: ['fd_mean', 'tsnr'],
      totalMetrics: 2, ignoredColumns: [], missingMetrics: [], addToAll: true };
    const loaded = reduce(s, command);
    expect(loaded.panels[0].series).toEqual([{ kind: 'study' }]);
    expect(loaded.panels[1].series).toEqual([]);
    expect(reduce(s, { ...command, addToAll: false }).panels[0].series).toEqual([]);
  });
});
