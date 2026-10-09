import { describe, expect, it } from 'vitest';
import { asColumnId } from '@mriqc/shared';
import { defaultDashboard, initialState, reduce } from '../../graph/reducer';
import { densityQueries } from '../../graph/queries';
import { decodeUrlState, encodeUrlState, urlState } from '../../graph/url';

const pair = () => reduce(reduce(initialState, { t: 'hydrate', url: defaultDashboard() }), {
  t: 'patchPanel', id: 'p1', patch: { y: asColumnId('snr'), form: 'heatmap' },
});

describe('element settings in links and queries', () => {
  it.each([30, 60, 120] as const)('sends %s cells per axis to density2d and preserves the setting in links', cells => {
    const state = reduce(pair(), { t: 'setPanelOptions', id: 'p1', options: { cells } });
    expect(densityQueries(state, state.panels[0])[0].grid).toBe(cells);
    const decoded = decodeUrlState(encodeUrlState(urlState(state)))!;
    expect(decoded.panels[0].options.cells ?? 60).toBe(cells);
  });
  it('defaults density requests to sixty cells per axis', () => {
    const state = pair(); expect(densityQueries(state, state.panels[0])[0].grid).toBe(60);
  });
  it.each(['linear', 'log', 'sqrt'] as const)('roundtrips a %s color scale and custom domain', colorScale => {
    const state = reduce(pair(), { t: 'setPanelOptions', id: 'p1', options: { colorScale, colorDomain: [1, 100] } });
    const decoded = decodeUrlState(encodeUrlState(urlState(state)))!;
    expect(decoded.panels[0].options.colorScale ?? 'log').toBe(colorScale);
    expect(decoded.panels[0].options.colorDomain).toEqual([1, 100]);
  });
  it('omits explicit count defaults from the encoded link', () => {
    const state = pair();
    const explicit = reduce(state, { t: 'setPanelOptions', id: 'p1', options: { cells: 60, colorScale: 'log', colorDomain: 'auto' } });
    expect(encodeUrlState(urlState(explicit))).toBe(encodeUrlState(urlState(state)));
  });
  it('retains an explicit log scale for Matrix', () => {
    const state = reduce(pair(), { t: 'patchPanel', id: 'p1', patch: { y: null, form: 'matrix', options: { metrics: [asColumnId('fd_mean'), asColumnId('snr')], colorScale: 'log' } } });
    expect(state.panels[0].form).toBe('matrix');
    expect(decodeUrlState(encodeUrlState(urlState(state)))?.panels[0].options.colorScale).toBe('log');
  });
  it('omits the default linear matrix scale', () => {
    const state = reduce(pair(), { t: 'patchPanel', id: 'p1', patch: { y: null, form: 'matrix', options: { metrics: [asColumnId('fd_mean'), asColumnId('snr')] } } });
    expect(state.panels[0].form).toBe('matrix');
    const explicit = reduce(state, { t: 'setPanelOptions', id: 'p1', options: { colorScale: 'linear', colorDomain: 'auto' } });
    expect(encodeUrlState(urlState(explicit))).toBe(encodeUrlState(urlState(state)));
  });
});
