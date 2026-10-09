import { asColumnId, type Filter } from '@mriqc/shared';
import { BitReader, BitWriter, URL_VERSION } from '../graph/url-tokens';
import { decodeUrlState, encodeUrlState, validateUrlState, type UrlState } from '../graph/url';
import { OPEN_LO } from '../graph/filters';
import { defaultDashboard } from '../graph/reducer';
import { defaultPanelOptions, type Cohort } from '../graph/state';

const filters: Filter[] = [
  { field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS', 'GE MEDICAL SYSTEMS'] },
  { field: asColumnId('created_at'), op: 'between', lo: '2020-01-01', hi: '2021-01-01' },
  { field: asColumnId('task_id'), op: 'notNull' },
];

const sample: UrlState = {
  global: { modality: 'bold', view: 'k4plus', filters },
  cohorts: [],
  panels: [
    {
      id: 'p1',
      y: null,
      x: asColumnId('fd_mean'),
      form: 'histogram',
      series: [],

      options: { ...defaultPanelOptions(), bins: 64, xScale: 'log' },
    },
    {
      id: 'p2',
      y: null,
      x: 'created_at',
      form: 'histogram',
      series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],

      options: { ...defaultPanelOptions('none'), granularity: 'year', useSelection: false },
    },
  ],
  selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
};

describe('url', () => {
  it('round-trips a dashboard through the s parameter', () => {
    const decoded = decodeUrlState(encodeUrlState(sample));
    expect(decoded).toEqual(sample);
  });

  it('round-trips a custom split with merged values and a metric band', () => {
    const split: UrlState = {
      ...sample,
      panels: [{
        ...sample.panels[0],
        series: [{
          kind: 'buckets' as const,
          buckets: [
            { name: 'Siemens or GE', filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS', 'GE MEDICAL SYSTEMS'] }] },
            { name: 'High tSNR', filters: [], selections: [{ metric: asColumnId('tsnr'), range: [40, 120] }] },
          ],
        }],
      }],
    };
    expect(decodeUrlState(encodeUrlState(split))?.panels[0].series).toEqual(split.panels[0].series);
  });

  it('round-trips a dashboard with no filters, panels or selection', () => {
    const empty: UrlState = {
      global: { modality: 'T1w', view: 'raw', filters: [] },
      cohorts: [],
      panels: [],
      selections: [],
    };
    expect(decodeUrlState(encodeUrlState(empty))).toEqual(empty);
  });

  it('survives query-parameter URL escaping', () => {
    const encoded = encodeUrlState(sample);
    const params = new URLSearchParams({ s: encoded });
    expect(decodeUrlState(new URLSearchParams(params.toString()).get('s'))).toEqual(sample);
  });

  it('survives non-ascii filter values', () => {
    const accented: UrlState = {
      ...sample,
      global: {
        ...sample.global,
        filters: [{ field: asColumnId('institution_name'), op: 'in', values: ['Hôpital Béclère'] }],
      },
    };
    expect(decodeUrlState(encodeUrlState(accented))).toEqual(accented);
  });

  it('returns null rather than throwing on junk', () => {
    expect(decodeUrlState(null)).toBeNull();
    expect(decodeUrlState('')).toBeNull();
    expect(decodeUrlState('not-base64-json')).toBeNull();
    expect(decodeUrlState(btoa('{"m":"MRI"}'))).toBeNull();
  });

  it('clamps bin counts into 10..200', () => {
    const wide = {
      ...sample,
      panels: [{ ...sample.panels[0], options: { ...sample.panels[0].options, bins: 5000 } }],
    };
    const decoded = decodeUrlState(encodeUrlState(wide));
    expect(decoded?.panels[0].options.bins).toBe(200);
  });

  it("falls back to the modality's canonical view when a link names one it lacks", () => {
    const wrong = { ...sample, global: { ...sample.global, modality: 'T1w' as const } };
    expect(decodeUrlState(encodeUrlState(wrong))?.global.view).toBe('k3pp');
  });

  it('falls back to the chart its kind opens on, in the compact format', () => {
    // The compact format writes a token, so a chart outside the kind's list can
    // only come from a hand-edited payload -- and the kinder answer is the card
    // the link asked for, on the chart that kind draws.
    const tampered: UrlState = {
      ...sample,
      panels: [{ ...sample.panels[0], form: 'bars' as never }],
    };
    const decoded = decodeUrlState(encodeUrlState(tampered));
    expect(decoded?.panels).toHaveLength(1);
    expect(decoded?.panels[0].form).toBe('histogram');
  });

  describe('the compact format', () => {
    it('round-trips text carrying the grammar’s own separators', () => {
      // The payload is a delimited text, so a value with a separator in it is
      // the one thing that could tear a record in half.
      const nasty = 'a;b,c:d|e~f!g#h?i%j%3Bk_^';
      const awkward: UrlState = {
        ...sample,
        global: {
          modality: 'bold',
          view: 'k4plus',
          filters: [
            { field: asColumnId('institution_name'), op: 'in', values: [nasty, '', 'Hôpital'] },
          ],
        },
        cohorts: [
          {
            id: 'c1',
            name: nasty,
            color: 2,
            source: 'population',
            view: 'k4plus',
            filters: [{ field: asColumnId('manufacturer'), op: 'in', values: [nasty] }],
            selections: [],
          },
        ],
        panels: [{ ...sample.panels[0], id: 'odd:id;1' }],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(awkward))).toEqual(awkward);
    });

    it('round-trips filter values and bounds of every shape', () => {
      const shapes: UrlState = {
        global: {
          modality: 'bold',
          view: 'k4plus',
          filters: [
            { field: asColumnId('manufacturer'), op: 'in', values: [1.5, true, false, 'x'] },
            { field: asColumnId('echo_time'), op: 'between', lo: -1.25e-7, hi: 20200101 },
            {
              field: asColumnId('created_at'),
              op: 'between',
              lo: '2019-12-31T23:30:00.000Z',
              hi: '2021-01-01',
            },
            { field: asColumnId('task_id'), op: 'isNull' },
          ],
        },
        cohorts: [],
        panels: [],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(shapes))).toEqual(shapes);
    });

    it('round-trips an open-ended numeric range exactly', () => {
      // The sentinels have to come back bit-for-bit or `formFromGlobal` stops
      // reading an open end as empty.
      const open: UrlState = {
        global: {
          modality: 'bold',
          view: 'k4plus',
          filters: [{ field: asColumnId('echo_time'), op: 'between', lo: OPEN_LO, hi: 0.01 }],
        },
        cohorts: [],
        panels: [],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(open))?.global.filters).toEqual(open.global.filters);
    });

    it('keeps a filter on the "Not reported" bucket alone', () => {
      // `NONE_FILTER_VALUE` is the empty string, so a list of exactly one empty
      // value is a real filter and not an empty list.
      const none: UrlState = {
        global: {
          modality: 'bold',
          view: 'k4plus',
          filters: [{ field: asColumnId('manufacturer'), op: 'in', values: [''] }],
        },
        cohorts: [],
        panels: [],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(none))?.global.filters).toEqual(none.global.filters);
    });

    it('keeps a lone panel, or a lone cohort, that is all defaults', () => {
      // Such a record writes nothing of its own, and a one-element list of them
      // joins to the empty text -- which is exactly what an omitted list looks
      // like, so the panel used to vanish from its own link.
      const bare: UrlState = {
        global: { modality: 'bold', view: 'k4plus', filters: [] },
        cohorts: [
          {
            id: 'c1',
            name: 'Cohort',
            color: 0,
            source: 'population',
            view: 'k4plus',
            filters: [],
            selections: [],
          },
        ],
        panels: [
          {
            id: 'p1',
            y: null,
            x: asColumnId('fd_mean'),
            form: 'density',
            series: [],

            options: defaultPanelOptions(),
          },
        ],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(bare))).toEqual(bare);
    });

    it('round-trips a dashboard with nothing on it', () => {
      // Deleting every card is a state a link has to be able to carry, and it
      // is all-defaults from end to end.
      const empty: UrlState = {
        global: { modality: 'bold', view: 'k4plus', filters: [] },
        cohorts: [],
        panels: [],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(empty))).toEqual(empty);
    });

    it('refuses a stored cohort that claims a derived id', () => {
      // `current`, `all` and a split group are derived: a stored cohort under
      // one of those ids could never be edited or deleted, because every lookup
      // answers with the derived one.
      const hijack: UrlState = {
        global: { modality: 'bold', view: 'k4plus', filters: [] },
        cohorts: [
          {
            id: 'current',
            name: 'Hijack',
            color: 4,
            source: 'population',
            view: 'k4plus',
            filters: [],
            selections: [],
          },
        ],
        panels: [],
        selections: [],
      };
      expect(decodeUrlState(encodeUrlState(hijack))?.cohorts).toEqual([]);
      expect(validateUrlState(hijack).cohorts).toEqual([]);
    });

    it('refuses an oversized stream', () => {
      expect(decodeUrlState(`1${'A'.repeat(5000)}`)).toBeNull();
    });

    it('omits the parameter for the default dashboard', () => {
      expect(encodeUrlState(defaultDashboard())).toBe('');
    });

    it('keeps ten panels with three cohorts and a brush under 400', () => {
      const cohorts: Cohort[] = [0, 1, 2].map((i) => ({
        id: `c${i + 1}`,
        name: `BOLD \u00b7 K4+ \u00b7 SIEMENS \u00b7 201${i}\u20132021`,
        color: i + 2,
        source: 'population' as const,
        view: 'k4plus' as const,
        filters: [{ field: asColumnId('manufacturer'), op: 'in' as const, values: ['SIEMENS'] }],
        selections: [],
      }));
      const metrics = ['fd_mean', 'tsnr', 'dvars_std', 'snr', 'efc', 'fber', 'aor', 'aqi'];
      const many: UrlState = {
        global: {
          modality: 'bold',
          view: 'k4plus',
          filters: [
            {
              field: asColumnId('manufacturer'),
              op: 'in',
              values: ['SIEMENS', 'Philips Medical Systems'],
            },
          ],
        },
        cohorts,
        panels: [
          ...metrics.map((metric, i) => ({
            id: `p${i + 1}`,
            y: null,
            x: asColumnId(metric),
            form: 'histogram' as const,
            series: [{ kind: 'cohort' as const, id: 'current' as const }],

            options: defaultPanelOptions(),
          })),
          {
            id: 'p9',
            y: null,
            x: asColumnId('fd_mean'),
            form: 'density' as const,
            series: [
              { kind: 'cohort' as const, id: 'c1' },
              { kind: 'cohort' as const, id: 'c2' },
            ],

            options: defaultPanelOptions(),

            reference: 'c2',
          },
          {
            id: 'p10',
            y: null,
            x: asColumnId('tsnr'),
            form: 'ecdf' as const,
            series: [{ kind: 'population' as const }, { kind: 'cohort' as const, id: 'c3' }],

            options: { ...defaultPanelOptions(), bins: 64, xScale: 'log' },
          },
        ],
        selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.103456, 0.41234] }],
      };
      const encoded = encodeUrlState(many);
      expect(encoded.length).toBeLessThan(400);
      expect(decodeUrlState(encoded)?.panels).toHaveLength(10);
      expect(decodeUrlState(encoded)?.cohorts).toHaveLength(3);
    });

    it('refuses a payload written under a version it cannot read', () => {
      const encoded = encodeUrlState(sample);
      expect(decodeUrlState(`9${encoded.slice(1)}`)).toBeNull();
    });
  });

  describe('validateUrlState', () => {
    it('drops a between filter whose bounds are not dates', () => {
      const bad: UrlState = {
        ...sample,
        global: {
          modality: 'bold',
          view: 'raw',
          filters: [
            { field: asColumnId('created_at'), op: 'between', lo: 'yesterday', hi: 'soon' },
          ],
        },
      };
      expect(validateUrlState(bad).global.filters).toEqual([]);
    });

    it('drops an op the field kind does not allow', () => {
      const bad: UrlState = {
        ...sample,
        global: {
          modality: 'bold',
          view: 'raw',
          filters: [{ field: asColumnId('manufacturer'), op: 'between', lo: 0, hi: 1 }],
        },
      };
      expect(validateUrlState(bad).global.filters).toEqual([]);
    });

    it('normalizes an inverted selection range rather than passing it to the server', () => {
      const inverted: UrlState = {
        ...sample,
        selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [9, 1] }],
      };
      expect(validateUrlState(inverted).selections[0]?.range).toEqual([1, 9]);
      const nan: UrlState = {
        ...sample,
        selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [Number.NaN, 1] }],
      };
      expect(validateUrlState(nan).selections).toEqual([]);
    });

    it('gives two panels that share an id unique ids', () => {
      const clashing: UrlState = {
        ...sample,
        panels: [sample.panels[0], { ...sample.panels[1], id: 'p1' }],
      };
      const ids = validateUrlState(clashing).panels.map((p) => p.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('nulls a metric the modality does not have', () => {
      const wrongModality: UrlState = {
        ...sample,
        global: { modality: 'T1w', view: 'raw', filters },
      };
      const validated = validateUrlState(wrongModality);
      expect(validated.panels[0].x).toBe('qi_1');
      expect(validated.selections).toEqual([]);
    });

    it('drops a filter on a field the view does not carry', () => {
      const canonicalOnly: UrlState = {
        ...sample,
        global: {
          modality: 'bold',
          view: 'raw',
          filters: [{ field: asColumnId('canonical_hmc_mode'), op: 'in', values: ['volreg'] }],
        },
      };
      expect(validateUrlState(canonicalOnly).global.filters).toHaveLength(0);
    });

    it('keeps everything valid untouched', () => {
      expect(validateUrlState(sample)).toEqual(sample);
    });
  });
});

describe('cohorts in the url', () => {
  const siemens: Cohort = {
    id: 'c1',
    name: 'Siemens 3T',
    color: 2,
    source: 'population',
    view: 'k4plus',
    filters: [
      { field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] },
      { field: asColumnId('created_at'), op: 'between', lo: '2019-01-01', hi: '2019-12-31' },
    ],
    selections: [{ metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
  };

  const withCohorts: UrlState = {
    ...sample,
    cohorts: [siemens, { ...siemens, id: 'c2', name: 'Philips', color: 3, selections: [] }],
    panels: [
      {
        id: 'p1',
        y: null,
        x: asColumnId('fd_mean'),
        form: 'histogram',
        series: [
          { kind: 'cohort' as const, id: 'c1' },
          { kind: 'cohort' as const, id: 'c2' },
        ],

        options: defaultPanelOptions(),

        reference: 'c2',
      },
    ],
  };

  it('round-trips cohorts and a panel’s cohort list', () => {
    expect(decodeUrlState(encodeUrlState(withCohorts))).toEqual(withCohorts);
  });

  it('keeps a study cohort out of the link', () => {
    // A study's rows never leave this browser, so a link carrying its cohort
    // would promise its recipient a comparison they cannot have.
    const withStudy: UrlState = {
      ...sample,
      cohorts: [{ ...siemens, id: 'c9', source: 'study' }],
    };
    expect(decodeUrlState(encodeUrlState(withStudy))?.cohorts).toEqual([]);
  });

  it('rejects a crafted study cohort during URL validation', () => {
    const crafted: UrlState = {
      ...sample,
      cohorts: [{ ...siemens, id: 'c9', source: 'study' }],
    };
    expect(validateUrlState(crafted).cohorts).toEqual([]);
  });

  it('validates a cohort against its own view, not the top bar’s', () => {
    const crossView: UrlState = {
      ...withCohorts,
      global: { modality: 'bold', view: 'raw', filters: [] },
      cohorts: [
        {
          ...siemens,
          view: 'k4plus',
          // A canonical-only column, which the cohort's own `k4plus` view has
          // and the top bar's `raw` does not.
          filters: [{ field: asColumnId('canonical_hmc_mode'), op: 'in', values: ['afni'] }],
          selections: [],
        },
      ],
    };
    expect(validateUrlState(crossView).cohorts[0].filters).toHaveLength(1);
  });

  it('drops a panel’s reference to a cohort the link did not carry', () => {
    const dangling: UrlState = { ...withCohorts, cohorts: [] };
    expect(validateUrlState(dangling).panels[0].series).toEqual([]);
  });

  it('moves a cohort to the canonical view of a modality that lacks its own', () => {
    const t1w: UrlState = {
      ...withCohorts,
      global: { modality: 'T1w', view: 'raw', filters: [] },
      cohorts: [{ ...siemens, view: 'k4plus', filters: [], selections: [] }],
      panels: [],
    };
    // `k4plus` is bold-only; the honest substitute is the other policy, not raw.
    expect(validateUrlState(t1w).cohorts[0].view).toBe('k3pp');
  });
});

describe('strict stream framing', () => {
  it('refuses every truncation of a non-default record', () => {
    const encoded = encodeUrlState(sample);
    for (let i = 1; i < encoded.length; i++) expect(decodeUrlState(encoded.slice(0, i))).toBeNull();
  });
  it('refuses appended data, invalid alphabet and unknown presence bits', () => {
    const encoded = encodeUrlState(sample);
    expect(decodeUrlState(encoded + 'A')).toBeNull();
    expect(decodeUrlState(encoded + '%')).toBeNull();
    const writer = new BitWriter();
    writer.write(6, 0);
    writer.write(6, 4);
    expect(decodeUrlState(URL_VERSION + writer.finish())).toBeNull();
  });
  it('round-trips duplicate identities without stealing a later identity', () => {
    const cohorts = ['c1', 'c1', 'c2'].map((id, i) => ({
      id,
      name: String(i),
      color: i + 2,
      source: 'population' as const,
      view: 'k4plus' as const,
      filters: [],
      selections: [],
    }));
    const decoded = decodeUrlState(encodeUrlState({ ...sample, cohorts }));
    expect(decoded?.cohorts.map((c) => c.id)).toEqual(['c1', 'c3', 'c2']);
  });
  it('never throws on arbitrary URL characters', () => {
    let seed = 71239;
    for (let i = 0; i < 500; i++) {
      const chars: string[] = ['1'];
      for (let n = 0; n < i % 80; n++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        chars.push(String.fromCharCode(seed % 128));
      }
      expect(() => decodeUrlState(chars.join(''))).not.toThrow();
    }
  });
});
