import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { asColumnId } from '@mriqc/shared';
import { API } from '../api/api';
import { MockApi } from '../api/mock-api';
import { filtersFromForm, formFromGlobal } from '../chrome/controls-form';
import { OPEN_LO } from './filters';
import { Graph, urlSyncMode } from './graph';
import { urlState } from './url';
import { defaultPanelOptions, type State } from './state';
import { decodeUrlState, encodeUrlState, type UrlState } from './url';

/** Past `debounceTime(150)` on the controls form, with room to spare. */
const AFTER_DEBOUNCE_MS = 260;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A two-panel bold dashboard: not the default, so hydrating it is visible. */
const shared: UrlState = {
  global: { modality: 'bold', view: 'raw', filters: [] },
  cohorts: [],
  panels: [
    {
      id: 'p1',
      y: null,
      x: asColumnId('fd_mean'),
      form: 'histogram',
      series: [],

      options: defaultPanelOptions(),
    },
    {
      id: 'p2',
      y: null,
      x: asColumnId('aor'),
      form: 'ecdf',
      series: [],

      options: defaultPanelOptions(),
    },
  ],
  selections: [],
};

/**
 * Build the graph against an address bar, the way a cold load does. The states
 * array is the fold's output; the last entry is what the dashboard shows.
 */
function boot(search: string): { graph: Graph; states: State[] } {
  window.history.replaceState({}, '', search);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', children: [] }]),
      MockApi,
      { provide: API, useExisting: MockApi },
    ],
  });
  const graph = TestBed.inject(Graph);
  const states: State[] = [];
  graph.state$.subscribe((state) => states.push(state));
  return { graph, states };
}

function sParam(): string | null {
  return new URLSearchParams(window.location.search).get('s');
}

describe('urlSyncMode', () => {
  it('replaces the first sync after a hydrate, whatever the url holds', () => {
    expect(urlSyncMode(true, 'abc', null)).toBe('replace');
    expect(urlSyncMode(true, 'abc', 'abc')).toBe('replace');
    expect(urlSyncMode(true, 'abc', 'xyz')).toBe('replace');
  });

  it('pushes a change the user made', () => {
    expect(urlSyncMode(false, 'abc', 'xyz')).toBe('push');
    expect(urlSyncMode(false, 'abc', null)).toBe('push');
  });

  it('replaces when the url already shows this state', () => {
    // Back and forward: the browser moved first and the hydrate folded to the
    // state that url encodes, so pushing would re-append the entry we left.
    expect(urlSyncMode(false, 'abc', 'abc')).toBe('replace');
  });
});

describe('Graph', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  describe('startup hydration', () => {
    it('opens the dashboard the url names and leaves the url alone', async () => {
      const encoded = encodeUrlState(shared);
      const { states } = boot(`/?s=${encoded}`);
      await wait(50);

      // Hydration is the first command, so the very first state already carries
      // the shared dashboard rather than the default one.
      expect(urlState(states[0])).toEqual(shared);
      expect(urlState(states.at(-1) as State)).toEqual(shared);
      expect(sParam()).toBe(encoded);
    });

    it('opens the default dashboard when the url carries nothing', async () => {
      const { states } = boot('/');
      await wait(50);
      expect(states[0].panels).toHaveLength(5);
      expect(sParam()).toBeNull();
      expect(states[0].panels.map((p) => p.x)).toEqual([
        'fd_mean',
        'tsnr',
        'dvars_std',
        'snr',
        'created_at',
      ]);
    });

    it('opens the default dashboard when the url carries a crafted payload', async () => {
      const malicious = btoa('{"m":"bold","v":"raw","f":[null],"p":[5],"s":[1,2,3,4]}')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const { graph, states } = boot(`/?s=${malicious}`);
      await wait(50);
      // Nothing in the payload survived validation, so it is treated as no URL
      // state at all, and the loop is still alive afterwards -- a decode that
      // threw would have ended the dashboard here.
      expect(states.at(-1)?.panels).toHaveLength(5);
      expect(states.at(-1)?.notice).toContain('URL could not be read');
      expect(TestBed.inject(Router).url).toBe('/');
      graph.dispatch({ t: 'addPanel',  });
      expect(states.at(-1)?.panels).toHaveLength(6);
    });
  });

  describe('the controls form', () => {
    it('re-applies a filter the user picks again after a modality switch', async () => {
      const { graph, states } = boot('/');
      const last = () => states.at(-1) as State;

      graph.form.patchValue({ filters: { manufacturer: ['SIEMENS'] } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([
        { field: 'manufacturer', op: 'in', values: ['SIEMENS'] },
      ]);

      // The reducer clears filters on a modality switch and `syncForm` writes
      // the cleared value back into the control with `emitEvent: false`.
      graph.form.patchValue({ modality: 'T1w' });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.modality).toBe('T1w');
      expect(last().global.filters).toEqual([]);
      expect(graph.form.getRawValue().filters['manufacturer']).toEqual([]);

      graph.form.patchValue({ modality: 'bold' });
      await wait(AFTER_DEBOUNCE_MS);

      // Picking the same value again must not be swallowed by a source-side
      // memory that never saw the reset.
      graph.form.patchValue({ filters: { manufacturer: ['SIEMENS'] } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([
        { field: 'manufacturer', op: 'in', values: ['SIEMENS'] },
      ]);
    });

    it('survives a link whose date filter is not a date', async () => {
      const bad: UrlState = {
        ...shared,
        global: {
          modality: 'bold',
          view: 'raw',
          filters: [{ field: asColumnId('created_at'), op: 'between', lo: 'yesterday', hi: 'soon' }],
        },
      };
      const { graph, states } = boot(`/?s=${encodeUrlState(bad)}`);
      await wait(50);
      const last = () => states.at(-1) as State;

      expect(last().global.filters).toEqual([]);
      expect(graph.form.getRawValue().createdFrom).toBeNull();

      // The next change to any control used to call `toISOString()` on an
      // `Invalid Date` and error the fold from inside the source's `map`.
      graph.form.patchValue({ filters: { manufacturer: ['SIEMENS'] } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([
        { field: 'manufacturer', op: 'in', values: ['SIEMENS'] },
      ]);
    });
  });

  describe('the numeric range controls', () => {
    it('turns one end into a between filter, in state and in the url', async () => {
      const { graph, states } = boot('/');
      const last = () => states.at(-1) as State;
      await wait(50);
      expect(last().global.view).toBe('k4plus');

      graph.form.patchValue({ numeric: { canonical_diameter: { lo: null, hi: 0.01 } } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([
        { field: 'canonical_diameter', op: 'between', lo: OPEN_LO, hi: 0.01 },
      ]);
      // The link carries it, which is what makes a filtered dashboard
      // shareable: this is exactly the value the URL edge writes.
      const decoded = decodeUrlState(encodeUrlState(urlState(last())));
      expect(decoded?.global.filters).toEqual([
        { field: 'canonical_diameter', op: 'between', lo: OPEN_LO, hi: 0.01 },
      ]);
      // The open end comes back empty, not as the sentinel that stood for it.
      expect(graph.form.getRawValue().numeric['canonical_diameter']).toEqual({ lo: null, hi: 0.01 });
    });

    it('drops the filter when both ends are cleared', async () => {
      const { graph, states } = boot('/');
      const last = () => states.at(-1) as State;
      graph.form.patchValue({ numeric: { canonical_group_rows: { lo: 2, hi: 100 } } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([
        { field: 'canonical_group_rows', op: 'between', lo: 2, hi: 100 },
      ]);

      graph.form.patchValue({ numeric: { canonical_group_rows: { lo: null, hi: null } } });
      await wait(AFTER_DEBOUNCE_MS);
      expect(last().global.filters).toEqual([]);
    });

    it('orders a reversed pair rather than sending the server lo > hi', () => {
      expect(
        filtersFromForm({ numeric: { echo_time: { lo: 0.9, hi: 0.1 } } }),
      ).toEqual([{ field: 'echo_time', op: 'between', lo: 0.1, hi: 0.9 }]);
    });

    it('ignores a half-typed bound', () => {
      expect(filtersFromForm({ numeric: { echo_time: { lo: null, hi: null } } })).toEqual([]);
      expect(
        filtersFromForm({ numeric: { echo_time: { lo: Number.NaN, hi: null } } }),
      ).toEqual([]);
    });

    it('reads a hydrated range back into both boxes', () => {
      expect(
        formFromGlobal({
          modality: 'bold',
          view: 'k4plus',
          filters: [{ field: asColumnId('canonical_diameter'), op: 'between', lo: 0, hi: 1e-6 }],
        }).numeric['canonical_diameter'],
      ).toEqual({ lo: 0, hi: 1e-6 });
    });
  });
});
