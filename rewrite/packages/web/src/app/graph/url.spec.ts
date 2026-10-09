import { asColumnId, type Filter } from '@mriqc/shared';
import { inflateSync } from 'fflate';
import { RAW_TOKEN_VERSION, URL_DICTIONARY } from './url-tokens';
import { decodeUrlState, encodeUrlState, validateUrlState, type UrlState } from './url';
import { OPEN_LO } from './filters';
import { defaultDashboard } from './reducer';
import { defaultPanelOptions, type Cohort } from './state';

/**
 * The payload's own text, inflated: the white-box view the compaction tests
 * need. The first character is the format version, the rest base64url of a
 * deflate stream (`url.ts`).
 */
function payloadText(param: string): string {
  if (param[0] === RAW_TOKEN_VERSION) return param.slice(1);
  const padded = param.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  return new TextDecoder().decode(inflateSync(bytes, { dictionary: URL_DICTIONARY }));
}

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
      chart: 'histogram',
      split: null,
      cohorts: ['current'],
      options: { ...defaultPanelOptions(), bins: 64, xScale: 'log' },
    },
    {
      id: 'p2',
      y: null,
      x: 'created_at',
      chart: 'area',
      split: asColumnId('manufacturer'),
      cohorts: ['current'],
      options: { ...defaultPanelOptions('none'), granularity: 'year', useSelection: false },
    },
  ],
  selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
};

/** A hand-built wire payload, encoded the way `encodeUrlState` would. */
function encodeWire(wire: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const validPanel = ['p1', 'distribution', 'fd_mean', 'histogram', null, 40, 'p01p99', 2, 'month'];

describe('url', () => {
  it('round-trips a dashboard through the s parameter', () => {
    const decoded = decodeUrlState(encodeUrlState(sample));
    expect(decoded).toEqual(sample);
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
    const params = new URLSearchParams({s: encoded});
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

  it('clamps a bin count from an old link into 10..200', () => {
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

  it('falls back for a panel whose chart its kind does not allow, in the old format', () => {
    const param = encodeWire({
      m: 'bold',
      v: 'raw',
      f: [],
      p: [
        ['p1', 'distribution', 'fd_mean', 'stackedBar', null, 40, 'p01p99', 2, 'month'],
        validPanel,
      ],
    });
    const panels = decodeUrlState(param)?.panels;
    expect(panels).toHaveLength(2);
    expect(panels?.[0].chart).toBe('density');
  });

  it('falls back to the chart its kind opens on, in the compact format', () => {
    // The compact format writes a token, so a chart outside the kind's list can
    // only come from a hand-edited payload -- and the kinder answer is the card
    // the link asked for, on the chart that kind draws.
    const tampered: UrlState = {
      ...sample,
      panels: [{ ...sample.panels[0], chart: 'stackedBar' as never }],
    };
    const decoded = decodeUrlState(encodeUrlState(tampered));
    expect(decoded?.panels).toHaveLength(1);
    expect(decoded?.panels[0].chart).toBe('density');
  });

  /**
   * A decode that throws would error `state$` from inside the fold and kill
   * every projection and edge, so each of these is a dead page, not a bad
   * dashboard. They are JSON-valid and base64-valid: only the element shapes
   * are wrong.
   */
  describe('crafted payloads never throw', () => {
    it('survives a null filter, a non-array panel and a prototype-walking kind', () => {
      const param = encodeWire({
        m: 'bold',
        v: 'raw',
        f: [null],
        p: [5, ['p1', 'constructor', null, 'histogram', null, 40, 'p01p99', 0, 'month']],
      });
      // Nothing in it survived, so it was never a dashboard: the router edge
      // opens the default one rather than an empty one.
      expect(decodeUrlState(param)).toBeNull();
    });

    it('drops filter elements that are not filters', () => {
      const param = encodeWire({
        m: 'bold',
        v: 'raw',
        f: [
          null,
          5,
          [],
          ['manufacturer'],
          ['manufacturer', 'in', 'SIEMENS'],
          ['manufacturer', 'in', []],
          ['task_id', 'nn'],
        ],
        p: [validPanel],
      });
      expect(decodeUrlState(param)?.global.filters).toEqual([{ field: 'task_id', op: 'notNull' }]);
    });

    it('drops panel elements that are not panels', () => {
      const param = encodeWire({
        m: 'bold',
        v: 'raw',
        f: [],
        p: [
          null,
          'p1',
          {},
          [],
          ['p1', 'toString', null, 'histogram', null, 40, 'p01p99', 0, 'month'],
          validPanel,
        ],
      });
      expect(decodeUrlState(param)?.panels.map((p) => p.id)).toEqual(['p1']);
    });

    it('ignores a selection that is not a finite ordered range', () => {
      const withSelection = (s: unknown) =>
        decodeUrlState(encodeWire({ m: 'bold', v: 'raw', f: [], p: [validPanel], s }));
      expect(withSelection(['p1', 'fd_mean', null, 1])?.selections).toEqual([]);
      expect(withSelection(['p1', 'fd_mean', 'NaN', 1])?.selections).toEqual([]);
      expect(withSelection(['p1', 'fd_mean'])?.selections).toEqual([]);
      expect(withSelection({})?.selections).toEqual([]);
      // An inverted range is ordered, the way the interactive brush orders a
      // right-to-left drag, rather than passed on reversed.
      expect(withSelection(['p1', 'fd_mean', 9, 1])?.selections[0]?.range).toEqual([1, 9]);
    });

    it('drops a filter value carrying a lone surrogate, which would throw in the query key', () => {
      const param = encodeWire({
        m: 'bold',
        v: 'raw',
        f: [
          ['manufacturer', 'in', ['\ud800']],
          ['manufacturer', 'in', ['SIEMENS', '\udfff']],
          ['task_id', 'bt', '\ud800', 'x'],
        ],
        p: [validPanel],
      });
      const decoded = decodeUrlState(param);
      expect(decoded?.global.filters).toEqual([
        { field: 'manufacturer', op: 'in', values: ['SIEMENS'] },
      ]);
      expect(() =>
        (decoded?.global.filters ?? []).forEach((f) =>
          f.op === 'in' ? f.values.forEach((v) => encodeURIComponent(String(v))) : undefined,
        ),
      ).not.toThrow();
    });

    it('re-mints a panel id a link used twice', () => {
      const param = encodeWire({
        m: 'bold',
        v: 'raw',
        f: [],
        p: [validPanel, validPanel, validPanel],
      });
      const ids = decodeUrlState(param)?.panels.map((p) => p.id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });
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
            chart: 'density',
            split: null,
            cohorts: ['current'],
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

    it('refuses a payload that would inflate out of all proportion', () => {
      expect(decodeUrlState(`1${'A'.repeat(5000)}`)).toBeNull();
    });

    it('keeps a default dashboard under 80 characters', () => {
      expect(encodeUrlState(defaultDashboard()).length).toBeLessThan(80);
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
            chart: 'histogram' as const,
            split: null,
            cohorts: ['current' as const],
            options: defaultPanelOptions(),
          })),
          {
            id: 'p9',
            y: null,
            x: asColumnId('fd_mean'),
            chart: 'density' as const,
            split: null,
            
            options: defaultPanelOptions(),
            cohorts: ['current', 'c1', 'c2'],
            reference: 'c2',
          },
          {
            id: 'p10',
            y: null,
            x: asColumnId('tsnr'),
            chart: 'ecdf' as const,
            split: null,
            
            options: { ...defaultPanelOptions(), bins: 64, xScale: 'log' },
            cohorts: ['all', 'c3'],
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

    it('opens a link written before the version character existed', () => {
      // Captured from the previous encoder, before this pass changed it: seven
      // panels, a saved cohort and a comparison over it. A link in somebody's
      // chat window has to keep working.
      const old =
        'eyJtIjoiYm9sZCIsInYiOiJrNHBsdXMiLCJmIjpbXSwicCI6W1sicDEiLCJkaXN0cmlidXRpb24iLCJmZF9tZWFuIiwiaGlzdG9ncmFtIixudWxsLDQwLCJwMDFwOTkiLDIsIm1vbnRoIl0sWyJwMiIsImRpc3RyaWJ1dGlvbiIsInRzbnIiLCJoaXN0b2dyYW0iLG51bGwsNDAsInAwMXA5OSIsMiwibW9udGgiXSxbInAzIiwiZGlzdHJpYnV0aW9uIiwiZHZhcnNfc3RkIiwiZWNkZiIsbnVsbCw0MCwicDAxcDk5IiwyLCJtb250aCJdLFsicDQiLCJkaXN0cmlidXRpb24iLCJzbnIiLCJkZW5zaXR5IixudWxsLDQwLCJwMDFwOTkiLDIsIm1vbnRoIl0sWyJwNSIsImdyb3VwZWQiLCJmZF9tZWFuIiwiYm94IiwibWFudWZhY3R1cmVyIiw0MCwicDAxcDk5IiwyLCJtb250aCJdLFsicDYiLCJjb3ZlcmFnZSIsbnVsbCwic3RhY2tlZEJhciIsIm1hbnVmYWN0dXJlciIsNDAsInAwMXA5OSIsMiwibW9udGgiXSxbInA3IiwiY29tcGFyaXNvbiIsImZkX21lYW4iLCJkZW5zaXR5IixudWxsLDQwLCJwMDFwOTkiLDIsIm1vbnRoIixbImN1cnJlbnQiLCJjMSJdXV0sImMiOltbImMxIiwiQk9MRCDCtyBLNCsgwrcgU0lFTUVOUyDCtyAyMDE54oCTMjAyMSIsMiwicCIsIms0cGx1cyIsW1sibWFudWZhY3R1cmVyIiwiaW4iLFsiU0lFTUVOUyJdXSxbImNyZWF0ZWRfYXQiLCJidCIsIjIwMTktMDEtMDEiLCIyMDIxLTEyLTMxIl1dXV19';
      const decoded = decodeUrlState(old);
      expect(decoded?.panels.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
      expect(decoded?.panels[6].cohorts).toEqual(['current', 'c1']);
      expect(decoded?.cohorts.map((c) => c.name)).toEqual([
        'BOLD \u00b7 K4+ \u00b7 SIEMENS \u00b7 2019\u20132021',
      ]);
      expect(decoded?.global.view).toBe('k4plus');
      // And it re-encodes into the compact format, so copying the link shortens it.
      expect(encodeUrlState(decoded as UrlState).length).toBeLessThan(old.length / 2);
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
        chart: 'histogram',
        split: null,
        
        options: defaultPanelOptions(),
        cohorts: ['current', 'c1', 'c2'],
        reference: 'c2',
      },
    ],
  };

  it('round-trips cohorts and a panel’s cohort list', () => {
    expect(decodeUrlState(encodeUrlState(withCohorts))).toEqual(withCohorts);
  });

  it('writes nothing for a dashboard with no cohorts', () => {
    // The common case carries no cohort field at all, and a panel writes only
    // the fields that differ from what its kind defaults to.
    const fields = payloadText(encodeUrlState(sample)).split(';');
    expect(fields.some((field) => field.startsWith('c'))).toBe(false);
    expect(fields.some((field) => field.startsWith('p'))).toBe(true);
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

  it('decodes a link written before cohorts existed', () => {
    // The two comparison slots are appended to the panel tuple, so a short one
    // reads as "no cohorts" and the default overlay rather than as a bad panel.
    const old = encodeWire({ m: 'bold', v: 'raw', f: [], p: [validPanel] });
    const decoded = decodeUrlState(old);
    expect(decoded?.cohorts).toEqual([]);
    expect(decoded?.panels[0].cohorts).toEqual(['current']);
  });

  it('rejects a cohort with no id, a reserved id, or a name that is not a string', () => {
    const wire = (c: unknown[]) =>
      decodeUrlState(encodeWire({ m: 'bold', v: 'raw', f: [], p: [validPanel], c: [c] }));
    // A whole-list rejection means the payload was not written by the encoder,
    // which is "no URL state" -- the default dashboard -- not an empty one.
    expect(wire(['', 'A', 0, 'p', 'raw', []])).toBeNull();
    expect(wire(['current', 'A', 0, 'p', 'raw', []])).toBeNull();
    expect(wire(['all', 'A', 0, 'p', 'raw', []])).toBeNull();
    expect(wire(['c1', 42, 0, 'p', 'raw', []])).toBeNull();
  });

  it('never re-mints onto an id a later cohort already owns', () => {
    // Re-minting against the ids walked past so far would rename the duplicate
    // of c1 to 'c2' and push the real c2 to 'c3' -- and a panel naming c2
    // would then bind to the copy of c1.
    const decoded = decodeUrlState(
      encodeWire({
        m: 'bold',
        v: 'raw',
        f: [],
        p: [validPanel],
        c: [
          ['c1', 'A', 0, 'p', 'raw', []],
          ['c1', 'B', 1, 'p', 'raw', []],
          ['c2', 'C', 2, 'p', 'raw', []],
        ],
      }),
    );
    expect(decoded?.cohorts.map((c) => [c.id, c.name])).toEqual([
      ['c1', 'A'],
      ['c3', 'B'],
      ['c2', 'C'],
    ]);
  });

  it('re-mints a repeated cohort id rather than dropping the cohort', () => {
    const decoded = decodeUrlState(
      encodeWire({
        m: 'bold',
        v: 'raw',
        f: [],
        p: [validPanel],
        c: [
          ['c1', 'A', 0, 'p', 'raw', []],
          ['c1', 'B', 1, 'p', 'raw', []],
        ],
      }),
    );
    expect(decoded?.cohorts.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(decoded?.cohorts.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('caps the cohort list and the per-panel cohort list', () => {
    const many = Array.from({ length: 40 }, (_, i) => [`c${i + 1}`, `C${i}`, 0, 'p', 'raw', []]);
    const decoded = decodeUrlState(
      encodeWire({ m: 'bold', v: 'raw', f: [], p: [validPanel], c: many }),
    );
    expect(decoded?.cohorts.length).toBeLessThanOrEqual(12);
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
    expect(validateUrlState(dangling).panels[0].cohorts).toEqual(['current']);
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
