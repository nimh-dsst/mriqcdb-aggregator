/**
 * Component tests for the cohort chips, the editor dialog, and the comparison
 * card they produce, against `MockApi` and a Vega that records instead of
 * drawing.
 *
 * They are in one file because they are one flow: the bar opens the editor, the
 * editor dispatches commands, and the card is what those commands make. Testing
 * them apart would need a mock of the thing being tested in each case.
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideNativeDateAdapter } from '@angular/material/core';
import { asColumnId } from '@mriqc/shared';
import { API } from '../api/api';
import { MOCK_LATENCY_MS, MockApi } from '../api/mock-api';
import { VEGA_EMBED } from '../panels/vega-view.directive';
import { Graph } from '../loop/graph';
import { resetPanelViewMemo } from '../slices/panels/view';
import { urlState } from '../url/url';
import type { State } from '../graph/state';
import { decodeUrlState, encodeUrlState } from '../url/url';
import { WEB_ICONS } from '../app.config';
import { Dashboard } from '../dashboard/dashboard';
import {
  PREVIEW_DEBOUNCE_MS,
  dateFilter,
  spanLabel,
  suggestName,
  withDateRange,
} from './cohort-editor';

/* jsdom has neither of these, and Angular Material asks for both. */
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

/** A Vega that records what it was asked to draw instead of drawing it. */
const embedded: { specs: unknown[]; datasets: Record<string, unknown> } = {
  specs: [],
  datasets: {},
};

function fakeEmbed() {
  return async (_el: unknown, spec: unknown) => {
    embedded.specs.push(spec);
    Object.assign(
      embedded.datasets,
      (spec as { datasets?: Record<string, unknown> }).datasets ?? {},
    );
    return {
      view: {
        data: (name: string, values: unknown) => {
          embedded.datasets[name] = values;
          return undefined;
        },
        runAsync: async () => undefined,
        addSignalListener: () => undefined,
        finalize: () => undefined,
      },
      finalize: () => undefined,
    };
  };
}

/* ------------------------------------------------------------ pure helpers */

describe('spanLabel', () => {
  it('writes a whole calendar year as the year', () => {
    // What a reader wants on a legend and in a cohort name: "2019", not
    // "1 Jan 2019 - 31 Dec 2019", which is the same fact at four times the width.
    expect(spanLabel(new Date('2019-01-01T00:00:00Z'), new Date('2019-12-31T00:00:00Z'))).toBe(
      '2019',
    );
  });

  it('writes any other span as two dates', () => {
    expect(spanLabel(new Date('2019-03-01T00:00:00Z'), new Date('2019-06-30T00:00:00Z'))).toBe(
      '1 Mar 2019 – 30 Jun 2019',
    );
  });

  it('says so when either end is missing', () => {
    expect(spanLabel(null, new Date('2019-12-31T00:00:00Z'))).toBe('all dates');
  });
});

describe('dateFilter', () => {
  it('builds a `created_at between` over two instants', () => {
    expect(dateFilter(new Date('2019-01-01T00:00:00Z'), new Date('2019-12-31T00:00:00Z'))).toEqual({
      field: 'created_at',
      op: 'between',
      lo: '2019-01-01T00:00:00.000Z',
      hi: '2019-12-31T00:00:00.000Z',
    });
  });

  it('orders the bounds, like every other two-ended control', () => {
    const reversed = dateFilter(
      new Date('2019-12-31T00:00:00Z'),
      new Date('2019-01-01T00:00:00Z'),
    );
    expect(reversed).toMatchObject({ lo: '2019-01-01T00:00:00.000Z' });
  });

  it('is nothing at all when either end is empty', () => {
    expect(dateFilter(null, new Date())).toBeNull();
  });
});

describe('withDateRange', () => {
  const manufacturer = {
    field: asColumnId('manufacturer'),
    op: 'in' as const,
    values: ['SIEMENS'],
  };

  it('replaces the date predicate and keeps every other filter', () => {
    // This is what makes a time-span comparison *the same cohort* across time:
    // only the date moves, so the two halves differ in nothing else.
    const base = [manufacturer, dateFilter(new Date('2019-01-01Z'), new Date('2019-12-31Z'))!];
    const moved = withDateRange(base, dateFilter(new Date('2024-01-01Z'), new Date('2024-12-31Z')));
    expect(moved).toHaveLength(2);
    expect(moved[0]).toBe(manufacturer);
    expect(moved[1]).toMatchObject({ field: 'created_at', lo: '2024-01-01T00:00:00.000Z' });
  });

  it('removes the date predicate when there is no span', () => {
    const base = [manufacturer, dateFilter(new Date('2019-01-01Z'), new Date('2019-12-31Z'))!];
    expect(withDateRange(base, null)).toEqual([manufacturer]);
  });
});

describe('suggestName', () => {
  it('suffixes a duplicate, so two cohorts are never one name', () => {
    // Two cohorts with the same name are indistinguishable in the legend and in
    // every row of the statistics table.
    expect(suggestName('Siemens 3T', 'create')).toBe('Siemens 3T copy');
  });

  it('leaves a time-span base alone, because the span is appended to it', () => {
    expect(suggestName('This dashboard', 'timespans')).toBe('This dashboard');
  });
});


describe('Save as group', () => {
  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    for (const stale of document.querySelectorAll('.cdk-overlay-container')) stale.remove();
    TestBed.configureTestingModule({
      imports: [Dashboard, WEB_ICONS],
      providers: [provideZonelessChangeDetection(), provideNativeDateAdapter(),
        provideRouter([{path:'**',children:[]}]), MockApi,
        {provide:API,useExisting:MockApi},
        {provide:VEGA_EMBED,useValue:() => Promise.resolve(fakeEmbed())}],
    });
  });
  async function settle(fixture: {whenStable:()=>Promise<unknown>}) {
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    TestBed.tick(); await fixture.whenStable();
  }
  async function start() {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    return fixture;
  }
  async function open(fixture: {nativeElement:unknown;whenStable:()=>Promise<unknown>}) {
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="cohort-save-current"]')!.click();
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="cohort-editor"]')).not.toBeNull());
    await settle(fixture);
    return document.querySelector<HTMLElement>('[data-testid="cohort-editor"]')!;
  }
  function snapshot(): State {
    let state!:State; const sub=TestBed.inject(Graph).state$.subscribe(value=>state=value); sub.unsubscribe(); return state;
  }
  function type(el:HTMLInputElement,value:string) { el.value=value;el.dispatchEvent(new Event('input',{bubbles:true})); }
  it('opens an editor and defaults Add to all cards on, without a Cohorts bar', async () => {
    const fixture=await start(); const editor=await open(fixture);
    expect(editor.querySelector('[data-testid="cohort-editor-title"]')?.textContent).toContain('Save as group');
    expect(editor.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('app-cohort-bar')).toBeNull();
    expect(editor.querySelector<HTMLInputElement>('[data-testid="cohort-name"]')?.value).not.toBe('');
  });
  it('prefills filters and brush, saves the snapshot and adds it to all cards', async () => {
    const fixture=await start(); const graph=TestBed.inject(Graph);
    graph.dispatch({t:'setFilters',filters:[{field:asColumnId('manufacturer'),op:'in',values:['Siemens']}]});
    graph.dispatch({t:'brush',from:'p1',metric:asColumnId('fd_mean'),range:[0.2,0.5]});
    await settle(fixture); const editor=await open(fixture);
    editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.click(); await settle(fixture);
    const state=snapshot();expect(state.cohorts).toHaveLength(1);
    expect(state.cohorts[0].filters).toContainEqual({field:'manufacturer',op:'in',values:['Siemens']});
    expect(state.cohorts[0].selections).toEqual([{metric:'fd_mean',range:[0.2,0.5]}]);
    expect(state.panels.every(panel=>panel.series.some(series=>series.kind==='cohort'&&series.id===state.cohorts[0].id))).toBe(true);
  });
  it('saves without adding to cards when unchecked', async () => {
    const fixture=await start();const editor=await open(fixture);
    editor.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.click();await settle(fixture);
    expect(snapshot().cohorts).toHaveLength(1);expect(snapshot().panels.every(panel=>panel.series.length===0)).toBe(true);
  });
  it('renames and deletes saved groups in the editor, pruning card series', async () => {
    const fixture=await start();let editor=await open(fixture);
    editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.click();await settle(fixture);
    editor=await open(fixture);
    const name=editor.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
    name.value='My group';name.dispatchEvent(new Event('change',{bubbles:true}));await settle(fixture);
    expect(snapshot().cohorts[0].name).toBe('My group');
    editor.querySelector<HTMLButtonElement>('[aria-label="Delete My group"]')!.click();await settle(fixture);
    expect(snapshot().cohorts).toEqual([]);expect(snapshot().panels.every(panel=>panel.series.length===0)).toBe(true);
  });
  it('refuses an empty name and preserves a name typed by the reader', async () => {
    const fixture=await start();const editor=await open(fixture);const name=editor.querySelector<HTMLInputElement>('[data-testid="cohort-name"]')!;
    type(name,'');await settle(fixture);expect(editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.disabled).toBe(true);
    type(name,'My selection');await settle(fixture);expect(name.value).toBe('My selection');
    expect(editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.disabled).toBe(false);
  });
  it('cancels without creating a group', async () => {
    const fixture=await start();const editor=await open(fixture);
    editor.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')!.click();await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-editor"]')).toBeNull();expect(snapshot().cohorts).toEqual([]);
  });
  it('auto-names repeated snapshots distinctly and round-trips their series', async () => {
    const fixture=await start();
    for(let i=0;i<2;i++){const editor=await open(fixture);editor.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')!.click();await settle(fixture);}
    const state=snapshot();expect(new Set(state.cohorts.map(c=>c.name)).size).toBe(2);
    const saved=urlState(state);expect(decodeUrlState(encodeUrlState(saved))).toEqual(saved);
  });
});
