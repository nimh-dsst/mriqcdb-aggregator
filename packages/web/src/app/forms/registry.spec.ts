import { validForm, brushable } from '../slices/panels/shapes';
import { defaultPanelOptions, type Form, type Panel } from '../graph/state';
import { normalizedOptions } from '../slices/panels/model';
import { asColumnId } from '@mriqc/shared';
import { FORM_DEFS, FORM_ORDER, formAvailability, formDef } from './registry';
import { CHART_TOKENS, URL_VERSION } from '../codec/tokens';
import { EXTRA_OPTION_FIELDS } from '../slices/panels/url';
import { FORM_INFO } from '../slices/panels/shapes';
import { FORM_GLYPHS } from '../panels/form-glyphs';

const order = ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table',
  'heatmap', 'scatter', 'hexbin', 'clusters', 'band', 'lines', 'bars', 'share', 'matrix'] as const;

describe('form registry', () => {
  it('pins every form and version-1 token position, including retired Hexbin', () => {
    expect(FORM_ORDER).toEqual(order);
    expect(URL_VERSION).toBe('1');
    expect(order.map(id => CHART_TOKENS.code.get(id))).toEqual('ABCDEFGHIJKLMNOP'.split(''));
    expect(new Set(FORM_ORDER).size).toBe(FORM_ORDER.length);
  });
  for (const id of order) {
    it(id + ' supplies the complete form contract and compatibility metadata', () => {
      const def = formDef(id);
      expect(def.id).toBe(id);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.glyph.length).toBeGreaterThan(0);
      expect(def.hint.length).toBeGreaterThan(0);
      expect(typeof def.availability).toBe('function');
      expect(typeof def.queries).toBe('function');
      expect(typeof def.spec).toBe('function');
      expect(typeof def.stats).toBe('function');
      expect(typeof def.brushable).toBe('boolean');
      expect(FORM_INFO[id]).toEqual({ label: def.label, icon: def.icon, hint: def.hint });
      expect(FORM_GLYPHS[id]).toBe(def.glyph);
      expect(Object.keys(def.options.defaults()).sort()).toEqual([...def.options.fields].sort());
    });
  }
  it('keeps wire slots unique and in the original order across form bags', () => {
    expect(EXTRA_OPTION_FIELDS.map(field => field.field)).toEqual([
      'colorScale', 'colorDomain', 'cells', 'quantiles', 'bins', 'clip', 'yMode', 'useSelection',
      'granularity', 'splitPresentation', 'cumulative', 'share', 'coverageWindow', 'coverageCustom',
      'coverageLogY', 'boxSort', 'coefficient', 'family', 'metrics', 'sampleSize', 'seed', 'k',
      'showPoints', 'clusterOrder', 'clusterSplit',
    ]);
    const fields = FORM_DEFS.flatMap(def => [...def.options.fields]);
    expect(new Set(fields).size).toBe(fields.length);
  });
  it('passes series through each availability rule without changing existing choices', () => {
    const x = asColumnId('fd_mean');
    const series = [{ kind: 'population' as const }];
    expect(formAvailability(x, null, series)).toEqual(FORM_DEFS.map(def => ({
      form: def.id, ...def.availability(x, null, series),
    })));
    expect(formAvailability(x, null, series)).toEqual(formAvailability(x, null, []));
  });
});

describe('unknown form compatibility boundary', () => {
  for (const [x, y, expected] of [
    [asColumnId('snr'), null, 'histogram'],
    ['created_at', asColumnId('snr'), 'band'],
    [asColumnId('snr'), asColumnId('fd_mean'), 'heatmap'],
    [asColumnId('manufacturer'), null, 'bars'],
  ] as const) {
    it('normalizes an unregistered form for ' + x + '/' + y, () => {
      const panel: Panel = { id: 'p1', x, y, form: 'unregistered' as Form,
        series: [], options: defaultPanelOptions(), cursors: [null] };
      expect(validForm(panel).form).toBe(expected);
      expect(brushable(panel)).toBe(false);
      expect(normalizedOptions(panel, { colorDomain: [-1, 1] }).colorDomain).toBe('auto');
    });
  }
});
