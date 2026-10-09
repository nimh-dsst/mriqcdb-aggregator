import { describe, expect, it } from 'vitest';
import { asColumnId, getAuthoredCatalog, type CompletedCatalog } from '@mriqc/shared';
import { defaultDashboard, reduce } from './reducer';
import { INITIAL_STATE, groupCohortId } from './state';
import { panelCohorts, panelQueries } from './queries';
import { queryKey } from '../api/api';
import { decodeUrlState, encodeUrlState, urlState, type UrlState } from './url';
import { panelView } from '../view/panel-view';
import { splitFilter, splitValues } from './numeric-split';
import { BitWriter } from './url-tokens';
import { LEGACY_DASHBOARD_FIELDS, writeRecord } from './url-fields';

const initial = () => reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
describe('x, y and aggregate grammar', () => {
  it('reads version-1 URLs without interpreting the old field positions as the new schema', () => {
    const url = defaultDashboard();
    const panels = url.panels.map((panel, index) => ({ ...panel, y: index === 1 ? asColumnId('tsnr') : null,
      form: index === 1 ? 'lines' : panel.form, options: { ...panel.options, yMode: index === 0 ? 'share' : 'count' } }));
    const source = { ...url.global, cohorts: [], panels, selections: [] };
    const writer = new BitWriter();
    writeRecord(writer, LEGACY_DASHBOARD_FIELDS, source, { index: 0, root: source, draft: source });
    const decoded = decodeUrlState('1' + writer.finish())!;
    expect(decoded.panels[0]).toMatchObject({ y: 'share', aggregate: 'median' });
    expect(decoded.panels[1]).toMatchObject({ y: 'tsnr', aggregate: 'median', form: 'band', options: { fill: 'lines' } });
    expect(encodeUrlState(decoded).startsWith('2')).toBe(true);
  });
  it('applies Log count to the categorical Bars spec through the card projection', () => {
    let state = reduce(initial(), { t: 'patchPanel', id: 'p1', patch: { x: asColumnId('manufacturer'), y: 'count', form: 'bars', options: { yMode: 'logCount' } } });
    const queries = panelQueries(state, state.panels[0]);
    state = { ...state, datasets: Object.fromEntries(queries.map(query => [queryKey(query), { status: 'ready' as const, version: state.dataVersion ?? 'v1',
      result: query.proc === 'coverage' ? { buckets: [{ start: '2024-01-01', group: 'A', n: 10 }, { start: '2024-01-01', group: 'B', n: 0 }] } : { groups: [] } }])) };
    const spec = panelView(state, 'p1')!.spec as any;
    expect(spec.encoding.y.scale.type).toBe('symlog');
    expect(spec.encoding.y.axis.title).toContain('(log)');
    expect(spec.encoding.x.type).toBe('nominal');
  });
  it('defaults every card to Count and median', () => {
    expect(initial().panels.every(panel => panel.y === 'count' && panel.aggregate === 'median')).toBe(true);
    const added = reduce(initial(), { t: 'addPanel', x: 'created_at' }).panels.at(-1)!;
    expect(added).toMatchObject({ y: 'count', aggregate: 'median', form: 'histogram' });
  });
  it('migrates null Y, old share mode, and Lines form during hydration', () => {
    const url = defaultDashboard();
    const panels = url.panels.map((panel, index) => ({ ...panel, aggregate: undefined,
      y: index === 2 ? asColumnId('tsnr') : null, form: index === 2 ? 'lines' : panel.form,
      options: { ...panel.options, yMode: index === 1 ? 'share' : 'count' } }));
    const migrated = reduce(INITIAL_STATE, { t: 'hydrate', url: { ...url, panels } as unknown as UrlState });
    expect(migrated.panels[0]).toMatchObject({ y: 'count', aggregate: 'median' });
    expect(migrated.panels[1].y).toBe('share');
    expect(migrated.panels[2]).toMatchObject({ y: 'tsnr', form: 'band', options: { fill: 'lines' } });
  });
  it.each(['count', 'share', asColumnId('tsnr')] as const)('round trips Y %s and aggregate', y => {
    const state = reduce(initial(), { t: 'patchPanel', id: 'p1', patch: { y, aggregate: 'mean', options: { fill: 'lines' } } });
    expect(decodeUrlState(encodeUrlState(urlState(state)))?.panels).toEqual(urlState(state).panels);
    expect(encodeUrlState(defaultDashboard())).toBe('');
  });
  it('derives titles from the selected axes', () => {
    let state = initial();
    expect(panelView(state, 'p5')?.title).toBe('Uploads over time');
    expect(panelView(state, 'p1')?.title).toBe('Mean framewise displacement');
    state = reduce(state, { t: 'patchPanel', id: 'p5', patch: { y: asColumnId('fd_mean') } });
    expect(panelView(state, 'p5')?.title).toBe('FD mean over time');
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { y: asColumnId('tsnr') } });
    expect(panelView(state, 'p1')?.title).toBe('tSNR vs FD mean');
  });
  it('removes one rendered field group and retains the remaining values and Other', () => {
    let state = initial();
    state = { ...state, catalog: { ...getAuthoredCatalog(), fieldValues: { manufacturer: { bold: { k4plus:
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((value, i) => ({ value, n: 10 - i })) } } } } as unknown as CompletedCatalog };
    state = reduce(state, { t: 'addPanelSeries', id: 'p1', series: { kind: 'field', field: asColumnId('manufacturer') } });
    state = reduce(state, { t: 'removePanelSeries', id: 'p1', key: groupCohortId('manufacturer', 'B') });
    expect(state.panels[0].series[0]).toEqual({ kind: 'values', field: 'manufacturer', values: ['A', 'C', 'D', 'E', 'other:["F","G"]'] });
    expect(panelCohorts(state, state.panels[0]).map(cohort => cohort.name)).toEqual(['A', 'C', 'D', 'E', 'Other']);
  });
  it('numeric splits use non-overlapping values descriptors and ordinary range filters', () => {
    const values = splitValues([2, 1, 2]);
    expect(values).toEqual(['bin:[null,1]', 'bin:[1,2]', 'bin:[2,null]']);
    const filters = values.map(value => splitFilter(asColumnId('magnetic_field_strength'), value)!);
    expect(filters[0]).toMatchObject({ op: 'between', lo: -Number.MAX_VALUE });
    expect(filters[1]).toMatchObject({ op: 'between', lo: 1 });
    expect(filters[2]).toMatchObject({ op: 'between', lo: 2, hi: Number.MAX_VALUE });
    expect((filters[0] as { hi: number }).hi).toBeLessThan(1);
    expect((filters[1] as { hi: number }).hi).toBeLessThan(2);
  });
});
