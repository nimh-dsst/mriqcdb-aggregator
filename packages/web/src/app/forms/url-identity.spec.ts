import { describe, expect, it } from 'vitest';

import { asColumnId } from '@mriqc/shared';

import { defaultDashboard } from '../slices/panels/defaults';
import { initialState, reduce } from '../loop/reducer';
import { defaultPanelOptions } from '../graph/state';
import { decodeUrlState, encodeUrlState, validateUrlState } from '../url/url';
import { type UrlState } from '../slices/history/url-state';

const roundTrip = (name: string, state: UrlState, limit: number) => {
  const token = encodeUrlState(state);
  const decoded = decodeUrlState(token) ?? (token === '' ? defaultDashboard() : null);

  // Captured from the version-1 codec before the registry refactor.
  const before: Record<string, string> = {
    'default': '',
    'three-filters': '1EADEDABCFDCABbLB8hyJ8iI-',
    'cohort-comparison': '1YACSOSiemens-cohortBEBASJGE-cohortBEBBBQACAAAA',
    'split-custom-range': '1QABwABCAAHDIeH0fCB',
    'explicit-layout': '1QDCBAEleftBAFrightYGMKGGB',
    'positional-layout': '1QDCAAAAYGMKGGB',
  };
  expect(token, name).toBe(before[name]);
  expect(encodeUrlState(decodeUrlState(before[name]) ?? defaultDashboard()), name).toBe(before[name]);
  expect(decoded).not.toBeNull();
  if (!decoded) {
    throw new Error('Encoded URL token did not decode');
  }
  expect(decoded).toEqual(state);
  return { token, decoded };
};

describe('version-1 URL byte identity', () => {
  it('round-trips representative dashboard states and hydrates them', () => {
    const defaultState = defaultDashboard();
    const filteredState: UrlState = {
      ...defaultDashboard(),
      global: {
        ...defaultDashboard().global,
        filters: [
          {
            field: asColumnId('manufacturer'),
            op: 'in',
            values: ['Siemens', 'GE', 'Philips'],
          },
          {
            field: asColumnId('magnetic_field_strength'),
            op: 'in',
            values: [1.5, 3],
          },
          {
            field: asColumnId('created_at'),
            op: 'between',
            lo: '2020-01-01',
            hi: '2024-01-01',
          },
        ],
      },
    };
    const cohortsState: UrlState = {
      ...defaultDashboard(),
      cohorts: [
        {
          id: 'c1',
          name: 'Siemens cohort',
          color: 2,
          source: 'population',
          view: defaultDashboard().global.view,
          filters: [
            {
              field: asColumnId('manufacturer'),
              op: 'in',
              values: ['Siemens'],
            },
          ],
          selections: [],
        },
        {
          id: 'c2',
          name: 'GE cohort',
          color: 3,
          source: 'population',
          view: defaultDashboard().global.view,
          filters: [
            {
              field: asColumnId('manufacturer'),
              op: 'in',
              values: ['GE'],
            },
          ],
          selections: [],
        },
      ],
      panels: [
        {
          ...defaultDashboard().panels[0],
          series: [
            { kind: 'cohort' as const, id: 'c1' },
            { kind: 'cohort' as const, id: 'c2' },
          ],
        },
      ],
    };
    const splitState: UrlState = {
      ...defaultDashboard(),
      panels: [
        {
          ...defaultDashboard().panels[0],
          series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
          form: 'histogram',
          options: {
            ...defaultPanelOptions(),
            layout: 'stacked',
            xRange: [0.1, 2.5],
            xScale: 'symlog',
          },
        },
      ],
    };
    const layoutState: UrlState = {
      ...defaultDashboard(),
      panels: [
        {
          ...defaultDashboard().panels[0],
          id: 'left',
        },
        {
          ...defaultDashboard().panels[0],
          id: 'right',
          x: asColumnId('tsnr'),
          y: null,
          form: 'histogram',
        },
      ],
      layout: {
        left: { x: 0, y: 0, w: 6, h: 12 },
        right: { x: 6, y: 0, w: 6, h: 10 },
      },
      maximizedPanel: 'right',
    };

    // Custom splits made the series record's seventh optional field, which
    // costs every series a second presence mask: six bits, one or two characters.
    const cases = [
      ['default', defaultState, 0],
      ['three-filters', filteredState, 40],
      ['cohort-comparison', cohortsState, 47],
      ['split-custom-range', splitState, 19],
      ['explicit-layout', layoutState, 26],
    ] as const;

    const positionalLayout: UrlState = { ...layoutState,
      panels: layoutState.panels.map((panel, index) => ({ ...panel, id: `p${index + 1}` })),
      layout: { p1: layoutState.layout!['left'], p2: layoutState.layout!['right'] }, maximizedPanel: 'p2' };
    roundTrip('positional-layout', positionalLayout, 18);
    for (const [name, state, limit] of cases) {
      const { decoded } = roundTrip(name, state, limit);
      expect(reduce(initialState, { t: 'hydrate', url: decoded })).toMatchObject(
        validateUrlState(decoded),
      );
    }
  });
});
