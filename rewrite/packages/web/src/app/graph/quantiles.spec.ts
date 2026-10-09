import { asColumnId } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';
import { defaultDashboard, reduce } from './reducer';
import { INITIAL_STATE } from './state';
import { decodeUrlState, encodeUrlState, urlState } from './url';
import { EXTRA_OPTION_FIELDS, writeRecord } from './url-fields';
import { BitWriter } from './url-tokens';

describe('quantile options', () => {
  it.each(['band', 'lines'] as const)('preserves both settings through reducer and URL for %s', form => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { y: asColumnId('tsnr'), form } });
    for (const quantiles of ['tails', 'quartiles'] as const) {
      state = reduce(state, { t: 'setPanelOptions', id: 'p1', options: { quantiles } });
      const decoded = decodeUrlState(encodeUrlState(urlState(state)))!;
      const restored = reduce(INITIAL_STATE, { t: 'hydrate', url: decoded });
      expect(restored.panels[0]).toMatchObject({ form, options: { quantiles } });
    }
  });

  it('omits quartiles from the option record just like an absent value', () => {
    const schema = EXTRA_OPTION_FIELDS.filter(field => field.field === 'quantiles');
    const encode = (options: Record<string, unknown>) => {
      const writer = new BitWriter();
      writeRecord(writer, schema, options, { index: 0, root: {}, draft: {} });
      return writer.finish();
    };
    expect(encode({ quantiles: 'quartiles' })).toBe(encode({}));
    expect(encode({ quantiles: 'tails' })).not.toBe(encode({}));
  });

  it('encodes a non-default quantile setting with one value bit', () => {
    const codec = EXTRA_OPTION_FIELDS.find(field => field.field === 'quantiles')!.codec;
    const writer = new BitWriter();
    const write = vi.spyOn(writer, 'write');
    codec.write(writer, 'tails', { index: 0, root: {}, draft: {} });
    expect(write).toHaveBeenCalledExactlyOnceWith(1, 1);
  });

  it('defaults to quartiles for an invalid value', () => {
    const state = reduce(reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() }),
      { t: 'setPanelOptions', id: 'p1', options: { quantiles: 'invalid' as never } });
    expect(state.panels[0].options.quantiles).toBe('quartiles');
  });

  it('defaults a time partner to time x but preserves explicit swapped axes', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { x: asColumnId('fd_mean') } });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { y: asColumnId('created_at') } });
    expect(state.panels[0]).toMatchObject({ x: 'created_at', y: 'fd_mean', form: 'band' });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { x: asColumnId('fd_mean'), y: asColumnId('created_at') } });
    expect(state.panels[0]).toMatchObject({ x: 'fd_mean', y: 'created_at', form: 'band' });
  });

  it('does not turn a categorical card into a continuous pair', () => {
    let state = reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { x: asColumnId('manufacturer') } });
    state = reduce(state, { t: 'patchPanel', id: 'p1', patch: { y: asColumnId('created_at') } });
    expect(state.panels[0]).toMatchObject({ x: 'manufacturer', y: null, form: 'bars' });
  });
});
