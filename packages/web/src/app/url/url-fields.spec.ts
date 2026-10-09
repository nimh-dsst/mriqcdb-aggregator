import { asColumnId } from '@mriqc/shared';
import { defaultDashboard } from '../graph/reducer';
import { deriveLayout } from '../graph/layout';
import { defaultPanelOptions } from '../graph/state';
import { decodeUrlState, encodeUrlState, type UrlState } from '../graph/url';
import {
  readRecord,
  writeRecord,
  readUrlRecord,
  writeUrlRecord,
  type Context,
  type Schema,
} from '../graph/url-fields';
import { BitReader, BitWriter, enumeration, unsigned, textCodec } from '../graph/url-tokens';

describe('schema-positional records', () => {
  it('walks the same random record schema in both directions', () => {
    let seed = 98791;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const schema: Schema = [
      { field: 'x', codec: unsigned, default: 0 },
      { field: 'y', codec: unsigned, default: 0 },
      { field: 'width', codec: unsigned, default: 4 },
      { field: 'height', codec: unsigned, default: 10 },
      { field: 'form', codec: enumeration(['a', 'b', 'c']), default: 'a' },
      { field: 'name', codec: textCodec(80), default: '' },
      { field: 'extra', codec: unsigned, default: 0 },
    ];
    for (let i = 0; i < 1000; i++) {
      const value = {
        x: random() % 12,
        y: random() % 300,
        width: random() % 2 ? 4 : 12,
        height: random() % 2 ? 10 : random() % 500,
        form: ['a', 'b', 'c'][random() % 3],
        name: random() % 2 ? '' : 'Hôpital ' + random(),
        extra: random() % 2 ? 0 : random() % 4159,
      };
      const writer = new BitWriter();
      const context: Context = { index: 0, root: {}, draft: {} };
      writeRecord(writer, schema, value, context);
      const reader = new BitReader(writer.finish());
      expect(readRecord(reader, schema, context)).toEqual(value);
      reader.finish();
    }
  });

  it('round-trips randomized dashboard, panel, cohort, filter, selection and layout records', () => {
    let seed = 523;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 150; i++) {
      const global = {
        ...defaultDashboard().global,
        filters: [
          {
            field: asColumnId('echo_time'),
            op: 'between' as const,
            lo: random() / 1e8,
            hi: 50 + random() / 1e8,
          },
        ],
      };
      const panels = defaultDashboard()
        .panels.slice(0, 1 + (random() % 4))
        .map((panel, index) => ({
          ...panel,
          id: 'panel ' + index,
          series: [{ kind: 'cohort' as const, id: 'saved' }],
          options: {
            ...defaultPanelOptions(),
            bins: 10 + (random() % 191),
            xRange: [0.1, 25] as const,
            k: 2 + (random() % 20),
            seed: random(),
            showPoints: random() % 2 === 1,
            clusterOrder: random() % 2 === 1,
          },
        }));
      const url: UrlState = {
        global,
        panels,
        cohorts: [
          {
            id: 'saved',
            name: 'Group ' + i,
            color: 2,
            source: 'population',
            view: global.view,
            filters: global.filters,
            selections: [{ metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
          },
        ],
        selections: [{ from: panels[0].id, metric: asColumnId('fd_mean'), range: [0.1, 2.5] }],
        layout: {
          [panels[0].id]: { x: random() % 6, y: random() % 300, w: 6, h: 10 + (random() % 100) },
        },
        maximizedPanel: panels[0].id,
      };
      expect(decodeUrlState(encodeUrlState(url))).toEqual(url);
    }
  });

  it('omits derived geometry and restores the actual default panels', () => {
    const dashboard = defaultDashboard();
    expect(writeUrlRecord({ ...dashboard, layout: deriveLayout(dashboard.panels, 3) })).toBe('');
    expect(readUrlRecord('')).toEqual(dashboard);
    expect(decodeUrlState(encodeUrlState({ ...dashboard, panels: [] }))?.panels).toEqual([]);
  });
});
