import { asColumnId } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';

import { defaultPanelOptions, type MetricId } from './state';
import { URL_VERSION } from './url-tokens';
import { decodeUrlState, encodeUrlState, urlState, validateUrlState } from './url';

const snr = asColumnId('snr');
const tsnr = asColumnId('tsnr') as unknown as MetricId;
const manufacturer = asColumnId('manufacturer');
const magneticFieldStrength = asColumnId('magnetic_field_strength');
const acquisitionDate = asColumnId('created_at');

const urlModel = {
  global: { modality: 'bold', view: 'raw', filters: [] },
  cohorts: [
    {
      id: `pilot,cohort`,
      name: 'Pilot',
      filters: [],
      source: 'population',
      view: 'raw',
      color: 2,
      selections: [],
    },
  ],
  layout: { quantity: { x: 2, y: 1, w: 5, h: 5 } },
  maximizedPanel: 'quantity',
  panels: [
    {
      id: 'quantity',
      x: snr,
      y: null,
      form: 'histogram',
      series: [
        {
          kind: 'values',
          field: manufacturer,
          values: [`Siemens;GE`, `contains,separator`, `all:separators`],
        },
        { kind: 'population' },
        { kind: 'cohort', id: `pilot,cohort` },
      ],
      options: defaultPanelOptions(),
    },
    {
      id: 'category',
      x: manufacturer,
      y: null,
      form: 'share',
      series: [{ kind: 'field', field: magneticFieldStrength }],
      options: defaultPanelOptions(),
    },
    {
      id: 'time',
      x: acquisitionDate,
      y: snr,
      form: 'band',
      series: [{ kind: 'study' }],
      options: defaultPanelOptions(),
    },
    {
      id: 'pair',
      x: snr,
      y: tsnr,
      form: 'scatter',
      series: [{ kind: 'span', from: '2024-01-01', to: '2024-03-31' }],
      options: defaultPanelOptions(),
    },
    {
      id: 'matrix',
      x: snr,
      y: null,
      form: 'matrix',
      series: [],
      options: {
        ...defaultPanelOptions(),
        metrics: [snr as unknown as MetricId, tsnr],
      },
    },
  ],
  selections: [],
} as const;

const decodedPanels = (value: unknown): readonly Record<string, unknown>[] =>
  (value as { readonly panels: readonly Record<string, unknown>[] }).panels;

describe('graph URL scheme', () => {
  it('uses only the schema version character', () => {
    expect(URL_VERSION).toBe('1');
    expect(encodeUrlState(urlModel as never)).toMatch(/^1[A-Za-z0-9_-]+$/);
  });

  it('round-trips every panel axis shape, every series descriptor, and delimiter values', () => {
    const encoded = encodeUrlState(urlModel as never);
    const decoded = decodeUrlState(encoded);

    expect(validateUrlState(decoded as never)).toEqual(validateUrlState(urlModel as never));
    expect(decodedPanels(decoded)).toHaveLength(5);
    expect(decoded).toMatchObject({
      layout: { quantity: { x: 2, y: 1, w: 5, h: 5 } },
      maximizedPanel: 'quantity',
    });
    expect(decodedPanels(decoded)[0]?.['series']).toEqual(urlModel.panels[0].series);
  });

  it('omits cursor state when deriving a URL state from application state', () => {
    const applicationState = {
      ...urlModel,
      panels: urlModel.panels.map((panel) => ({
        ...panel,
        cursors: ['2024-01-01', null],
      })),
    };

    expect(urlState(applicationState as never)).toEqual(urlModel);
  });
});
