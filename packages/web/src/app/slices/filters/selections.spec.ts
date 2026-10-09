import { queryKey } from '../../api/api';
import { asColumnId } from '@mriqc/shared';
import { defaultDashboard } from '../panels/defaults';
import { reduce } from '../../loop/reducer';
import { panelQueries } from '../panels/queries';
import { INITIAL_STATE, type Panel } from '../../graph/state';
import { decodeUrlState, encodeUrlState, urlState } from '../../url/url';
import { readUrlRecord } from '../../url/fields';
import { METRIC_TOKENS, toToken } from '../../codec/tokens';

const fd = asColumnId('fd_mean'), tsnr = asColumnId('tsnr');
const initial = () => reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
const twoD = () => reduce(initial(), { t: 'patchPanel', id: 'p1', patch: { y: tsnr } });
const brush = (state = twoD()) => reduce(state, { t: 'brush2d', from: 'p1', x: fd, y: tsnr,
  ranges: { x: [1.2, 0.4], y: [60, 20] } });

describe('linked selection lists', () => {
  it('sets two ranges atomically, replaces one metric, and clears each independently', () => {
    const selected = brush();
    expect(selected.selections).toEqual([
      { from: 'p1', metric: fd, range: [0.4, 1.2] }, { from: 'p1', metric: tsnr, range: [20, 60] },
    ]);
    const replaced = reduce(selected, { t: 'brush', from: 'p2', metric: tsnr, range: [30, 50] });
    expect(replaced.selections).toHaveLength(2);
    expect(replaced.selections.find(s => s.metric === tsnr)).toEqual({ from: 'p2', metric: tsnr, range: [30, 50] });
    const cleared = reduce(replaced, { t: 'brush', from: 'p1', metric: fd, range: null });
    expect(cleared.selections.map(s => s.metric)).toEqual([tsnr]);
    expect(reduce(cleared, { t: 'clearSelections' }).selections).toEqual([]);
    expect(reduce(selected, { t: 'brush2d', from: 'p1', x: fd, y: tsnr, ranges: null }).selections).toEqual([]);
  });
  it('rejects a fifth metric and an overflowing 2D update without partial changes', () => {
    let state = initial();
    for (const panel of state.panels.slice(0, 4)) state = reduce(state, { t: 'brush', from: panel.id, metric: panel.x as typeof fd, range: [1, 2] });
    state = reduce(state, { t: 'addPanel',  x: asColumnId('gcor') });
    const before = state.selections;
    expect(reduce(state, { t: 'brush', from: 'p6', metric: asColumnId('gcor'), range: [0, 1] }).selections).toBe(before);
    state = reduce(state, { t: 'patchPanel', id: 'p6', patch: { y: fd } });
    expect(reduce(state, { t: 'brush2d', from: 'p6', x: asColumnId('gcor'), y: fd, ranges: { x: [0, 1], y: [2, 3] } }).selections).toBe(before);
    expect(reduce(state, { t: 'brush', from: 'p6', metric: asColumnId('gcor'), range: [NaN, 1] }).selections).toBe(before);
  });
  it('keeps the source unfiltered and carries both ranges in every other procedure key', () => {
    const base = twoD(), selected = brush(base);
    expect(panelQueries(selected, selected.panels[0])).toEqual(panelQueries(base, base.panels[0]));
    const common = { ...selected.panels[2], id: 'target' };
    const variants: Panel[] = [common,
      { ...common, series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'box' },
      { ...common, x: 'created_at', series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'histogram' },
      { ...common, form: 'table' }, { ...common, y: tsnr, form: 'heatmap' },
      { ...common, form: 'matrix', options: { ...common.options, metrics: [fd, tsnr] } }, { ...common, x: 'created_at', y: fd, form: 'band' }];
    expect(variants.map(panel => panelQueries(selected, panel)[0].proc)).toEqual([
      'distribution', 'distribution', 'coverage', 'sample', 'density2d', 'correlation', 'binnedSummary',
    ]);
    for (const panel of variants) for (const query of panelQueries(selected, panel)) {
      expect(query).toMatchObject({ selections: [{ metric: fd, range: [0.4, 1.2] }, { metric: tsnr, range: [20, 60] }] });
      expect(queryKey(query)).toContain('sel=fd_mean~0.4..1.2;tsnr~20..60');
    }
  });
  it('snapshots and names every range in a saved cohort', () => {
    const saved = reduce(brush(), { t: 'saveCurrentAsCohort' });
    expect(saved.cohorts[0].selections).toHaveLength(2);
    expect(saved.cohorts[0].name).toContain('FD mean 0.4–1.2');
    expect(saved.cohorts[0].name).toContain('tSNR 20–60');
    expect(reduce(saved, { t: 'clearSelections' }).cohorts[0]).toBe(saved.cohorts[0]);
  });
  it('round-trips dashboard and cohort ranges and rejects the removed singleton format', () => {
    const state = reduce(brush(), { t: 'saveCurrentAsCohort' });
    expect(decodeUrlState(encodeUrlState(urlState(state)))).toEqual(urlState(state));
    expect(readUrlRecord(`sp1,${toToken(METRIC_TOKENS, fd)},0.4,1.2`)).toBeNull();
  });
});
