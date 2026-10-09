import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { compile, type TopLevelSpec } from 'vega-lite';
import { Injectable, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideNativeDateAdapter } from '@angular/material/core';
import { Observable, throwError } from 'rxjs';
import {
  asColumnId,
  type CompletedCatalog,
  type DistributionResult,
} from '@mriqc/shared';
import { API, type DistributionQuery } from '../api/api';
import { MOCK_LATENCY_MS, MockApi } from '../api/mock-api';
import { VEGA_EMBED } from '../panels/vega-view.directive';
import { OPEN_LO } from '../graph/filters';
import { Graph } from '../graph/graph';
import { resetPanelViewMemo } from '../view/panel-view';
import { urlState } from '../graph/url';
import { defaultPanelOptions, type State } from '../graph/state';
import { decodeUrlState, encodeUrlState, type UrlState } from '../graph/url';
import { PHONE_QUERY } from '../chrome/media';
import { Theme, THEME_STORAGE_KEY } from '../chrome/theme';
import { WEB_ICONS } from '../app.config';
import { Dashboard } from './dashboard';

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
const embedded: { specs: unknown[]; datasets: Record<string, unknown> } = { specs: [], datasets: {} };

function fakeEmbed() {
  return async (_el: unknown, spec: unknown) => {
    embedded.specs.push(spec);
    // Rows reach Vega two ways: seeded into the spec on embed, pushed by name
    // afterwards. The fake records both.
    Object.assign(embedded.datasets, (spec as { datasets?: Record<string, unknown> }).datasets ?? {});
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

describe('Dashboard with MockApi', () => {
  beforeEach(() => {
    resetPanelViewMemo();
    // The dashboard hydrates from the address bar, so each test starts from a
    // bare one.
    window.history.replaceState({}, '', '/');
    embedded.specs = [];
    embedded.datasets = {};
    TestBed.configureTestingModule({
      imports: [Dashboard, WEB_ICONS],
      providers: [
        provideZonelessChangeDetection(),
        provideNativeDateAdapter(),
        provideRouter([{ path: '**', children: [] }]),
        MockApi,
        { provide: API, useExisting: MockApi },
        { provide: VEGA_EMBED, useValue: () => Promise.resolve(fakeEmbed()) },
      ],
    });
  });

  it('opens the default dashboard with five panels', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="panel-card"]');
    expect(cards).toHaveLength(5);
    expect([...cards].map(card => card.querySelector('[data-testid="metric-title"]')?.textContent)).toHaveLength(5);
    expect(cards[4].textContent).toContain('Uploads over time');
  });

  it('lists the numeric forms and changes the selected form through the dropdown', async () => {
    const fixture=TestBed.createComponent(Dashboard);await fixture.whenStable();
    const card=(fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p1"]')!;
    card.querySelector<HTMLElement>('[aria-label="Form"] .mat-mdc-select-trigger')!.click();await fixture.whenStable();
    const options=[...document.querySelectorAll<HTMLElement>('mat-option')];
    expect(options.map(option=>option.querySelector('.font-medium')?.textContent?.trim())).toEqual(['Histogram','Line','Area','Density','ECDF','Box','Table','Heatmap','Scatter','Hexbin','Clusters','Band','Lines']);
    options[3].click();await fixture.whenStable();
    expect(card.querySelector('[aria-label="Form"] .mat-mdc-select-trigger')!.textContent).toContain('Density');
    expect(card.querySelector('[data-testid="panel-split-selector"]')).toBeNull();
  });

  it('keeps only applicable element-independent settings in Options', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const graph = TestBed.inject(Graph);
    graph.dispatch({ t: 'patchPanel', id: 'p1', patch: { series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'box' } });
    await fixture.whenStable();
    const card = (fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p1"]')!;
    card.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')!.click();
    await fixture.whenStable();
    const menu = document.querySelector('.mat-mdc-menu-panel')!;
    expect(menu.querySelector('app-axes-controls')).toBeNull();
    expect(menu.textContent).not.toContain('Layout');
    expect(menu.textContent).not.toContain('Bins');
    expect(menu.textContent).toContain('Clip');
    expect(menu.textContent).not.toContain('Box sort');
    expect(menu.textContent).toContain('Follow brushed range');
    expect(menu.querySelector('[data-testid="panel-chart-selector"]')).toBeNull();
    expect(menu.querySelector('[data-testid="panel-show-selector"]')).toBeNull();
  });

  it('offers continuous forms for time counts and paired forms with a y metric', async () => {
    const fixture=TestBed.createComponent(Dashboard);await fixture.whenStable();
    const card=(fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p5"]')!;
    card.querySelector<HTMLElement>('[aria-label="Form"] .mat-mdc-select-trigger')!.click();await fixture.whenStable();
    const options=[...document.querySelectorAll<HTMLElement>('mat-option')];
    expect(options).toHaveLength(13);expect(options.filter(o=>o.getAttribute('aria-disabled')==='false').map(o=>o.querySelector(".font-medium")?.textContent?.trim())).toEqual(["Histogram","Line","Area","Density","ECDF","Box","Table"]);
    options[2].click();await fixture.whenStable();
    TestBed.inject(Graph).dispatch({t:'setPanelAxis',id:'p5',axis:'y',value:asColumnId('fd_mean')});
    await fixture.whenStable();
    expect(card.querySelector('[aria-label="Form"] .mat-mdc-select-trigger')!.textContent).toContain('Band');
    card.querySelector<HTMLElement>('[aria-label="Form"] .mat-mdc-select-trigger')!.click();
    await fixture.whenStable();
    const metricOptions=[...document.querySelectorAll<HTMLElement>('mat-option')];
    expect(metricOptions.map(o=>o.querySelector(".font-medium")?.textContent?.trim())).toEqual(["Heatmap","Scatter","Hexbin","Clusters","Band","Lines"]);
    metricOptions[5].click(); await fixture.whenStable();
    expect(card.querySelector('[aria-label="Form"] .mat-mdc-select-trigger')!.textContent).toContain('Lines');
  });

  it('derives pair and correlation titles from the selected quantity', async () => {
    const fixture=TestBed.createComponent(Dashboard);await fixture.whenStable();const graph=TestBed.inject(Graph);
    graph.dispatch({t:'setPanelAxis',id:'p1',axis:'y',value:asColumnId('tsnr')});await fixture.whenStable();
    const card=(fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p1"]')!;
    expect(card.querySelector<HTMLButtonElement>('[data-testid="metric-title"]')!.title).toBe('tSNR vs FD mean');
    graph.dispatch({t:'patchPanel',id:'p1',patch:{y:null,form:'matrix',options:{metrics:[asColumnId('fd_mean'),asColumnId('tsnr')]}}});await fixture.whenStable();
    expect(card.querySelector<HTMLButtonElement>('[data-testid="metric-title"]')!.title).toBe('Metric correlations');
    expect(card.querySelector('app-compare-input')).not.toBeNull();
  });

  it('offers saved groups and study through the one Compare menu', async () => {
    const fixture=TestBed.createComponent(Dashboard);await fixture.whenStable();const graph=TestBed.inject(Graph);
    graph.dispatch({t:'addCohort',cohort:{id:'saved',name:'Saved Siemens',color:2,source:'population',view:'k4plus',filters:[],selections:[]}});
    graph.dispatch({t:'studyLoaded',name:'study.csv',rows:10,metrics:[asColumnId('fd_mean')],totalMetrics:1,ignoredColumns:[],missingMetrics:[]});await fixture.whenStable();
    const card=(fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p1"]')!;
    card.querySelector<HTMLButtonElement>('button[aria-label="Add comparison"]')!.click();await fixture.whenStable();
    const options=[...document.querySelectorAll<HTMLButtonElement>('[mat-menu-item]')];
    expect(options.some(o=>o.textContent?.includes('My study'))).toBe(true);
    options.find(o=>o.textContent?.trim()==='Saved Siemens')!.click();await fixture.whenStable();
    let state!:State;const sub=graph.state$.subscribe(value=>state=value);
    expect(state.panels[0].series).toEqual([{kind:'cohort',id:'saved'}]);expect(state.panels[1].series).toEqual([]);sub.unsubscribe();
  });

  it('opens New group from Compare', async () => {
    const fixture=TestBed.createComponent(Dashboard);await fixture.whenStable();const open=vi.spyOn(TestBed.inject(MatDialog),'open');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-panel-id="p1"] button[aria-label="Add comparison"]')!.click();await fixture.whenStable();
    [...document.querySelectorAll<HTMLButtonElement>('[mat-menu-item]')].find(option=>option.textContent?.includes('New group'))!.click();
    await vi.waitFor(()=>expect(open).toHaveBeenCalled());
    expect(open).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({data:{mode:'create',seed:null,convertPanel:'p1'}}));
    TestBed.inject(MatDialog).closeAll();
  });

  it.each(['density', 'histogram', 'ecdf'] as const)('uses only the chips as the split %s legend', async chart => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const graph = TestBed.inject(Graph);
    graph.dispatch({ t: 'addPanelSeries', id: 'p4', series: { kind: 'field', field: asColumnId('manufacturer') } });
    graph.dispatch({ t: 'setPanelChart', id: 'p4', form: chart });
    await new Promise(resolve => setTimeout(resolve, MOCK_LATENCY_MS * 6));
    await fixture.whenStable();
    const card = (fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p4"]')!;
    expect(card.querySelectorAll('[data-testid="series-legend"]')).toHaveLength(0);
    expect(card.querySelectorAll('app-compare-input button[aria-pressed]').length).toBeGreaterThan(1);
    expect(card.querySelectorAll('[data-testid="comparison-table"]')).toHaveLength(1);
    let spec!: TopLevelSpec;
    const subscription = graph.panelView$('p4').subscribe(view => { if (view?.spec) spec = view.spec; });
    const compiled = compile(spec).spec;
    expect(JSON.stringify(compiled)).not.toContain('"legends":');
    subscription.unsubscribe();
  });

  it('exposes a labelled move grip before Maximize and handles its arrow keys on the card', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...matchMedia(query), matches: query.includes('min-width') });
    const fixture = TestBed.createComponent(Dashboard);
    try {
      await fixture.whenStable();
    } finally {
      window.matchMedia = matchMedia;
    }
    const root = fixture.nativeElement as HTMLElement;
    const cards = root.querySelectorAll('[data-testid="panel-card"]');
    for (const card of cards) {
      const grip = card.querySelector<HTMLButtonElement>('button[data-grid-drag]')!;
      expect(grip.getAttribute('aria-label')).toBe('Move panel (drag, or arrow keys)');
      expect(grip.querySelector('lucide-icon')?.getAttribute('name')).toBe('grip-vertical');
      expect(grip.nextElementSibling?.getAttribute('aria-label')).toBe('Maximize');
    }
    const host = root.querySelector<HTMLElement>('app-panel-card')!;
    const grip = host.querySelector<HTMLButtonElement>('button[data-grid-drag]')!;
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(host.style.gridColumn).toBe('2 / span 4');
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(host.style.gridColumn).toBe('2 / span 5');
    host.querySelector<HTMLButtonElement>('button[aria-label="Maximize"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(host.style.gridColumn).toBe('2 / span 5');
  });

  it('places the stacking explanation only in its card and removes it when overlaying', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const graph = TestBed.inject(Graph);
    graph.dispatch({ t: 'patchPanel', id: 'p4', patch: { series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] } });
    graph.dispatch({ t: 'setPanelOptions', id: 'p4', options: { layout: 'stacked' } });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const note = root.querySelector('[data-testid="stacking-note"]');
    expect(note?.closest('[data-panel-id]')?.getAttribute('data-panel-id')).toBe('p4');
    expect(note?.classList.contains('text-ink-2')).toBe(true);
    expect(note?.querySelector('lucide-icon[name="info"]')).not.toBeNull();
    expect(root.querySelector('app-top-bar [data-testid="notice"]')).toBeNull();
    expect(root.querySelectorAll('[data-testid="stacking-note"]')).toHaveLength(1);
    graph.dispatch({ t: 'setPanelOptions', id: 'p4', options: { layout: 'stacked100' } });
    await fixture.whenStable();
    expect(root.querySelectorAll('[data-testid="stacking-note"]')).toHaveLength(1);
    graph.dispatch({ t: 'setPanelOptions', id: 'p4', options: { layout: 'overlaid' } });
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="stacking-note"]')).toBeNull();
  });

  it('keeps the correlation footer after its chart and exposes a named resize handle on every card', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...matchMedia(query), matches: query.includes('min-width') });
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    window.matchMedia = matchMedia;
    TestBed.inject(Graph).dispatch({ t: 'patchPanel', id: 'p1', patch: { form: 'matrix', options: { metrics: [asColumnId('fd_mean'), asColumnId('tsnr')] } } });
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const card = root.querySelector('[data-panel-id="p1"]')!;
    const chart = card.querySelector('.panel-chart-slot')!;
    const note = card.querySelector('[data-testid="analysis-note"]')!;
    const pairs = card.querySelector('.correlation-pairs')!;
    const meaning = card.querySelector('[data-testid="panel-meaning"]')!;
    expect(chart.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(pairs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pairs.compareDocumentPosition(meaning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const panel of root.querySelectorAll('[data-testid="panel-card"]')) {
      expect(panel.querySelector('[data-grid-resize]')?.getAttribute('aria-label')).toBe('Resize panel');
    }
  });

  it('re-embeds charts with dark inks when the viewer changes theme', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const before = embedded.specs.length;
    const url = window.location.search;
    const theme = TestBed.inject(Theme);
    theme.set('dark');
    await fixture.whenStable();
    expect(embedded.specs.length).toBeGreaterThan(before);
    const last = embedded.specs.at(-1) as { config: { axis: { labelColor: string } } };
    expect(last.config.axis.labelColor).toBe('#9aa5b8');
    expect(window.location.search).toBe(url);
    theme.set('system');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('renders the dashboard a shared link names, and keeps the link', async () => {
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
          form: 'histogram',
          series: [],

          options: defaultPanelOptions(),
        },
      ],
      selections: [],
    };
    const encoded = encodeUrlState(shared);
    window.history.replaceState({}, '', `/?s=${encoded}`);

    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="panel-card"]',
    );
    expect(cards).toHaveLength(2);
    expect(new URLSearchParams(window.location.search).get('s')).toBe(encoded);
  });

  it('shows the top bar controls and a status line', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="modality-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="view-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="status-line"]')?.textContent).toContain('Loading');
  });

  it('loads every panel from the mock and pushes the data into Vega', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('[data-testid="panel-error"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="panel-loading"]')).toHaveLength(0);
    // The status line's resting state is how current the data is, not a word
    // for "nothing is happening" (docs/ui-style.md, "Copy").
    expect(host.querySelector('[data-testid="status-line"]')?.textContent).toContain(
      'Uploads through 30 Jun 2025',
    );

    expect(embedded.specs.length).toBeGreaterThanOrEqual(5);
    expect((embedded.datasets['population'] as unknown[]).length).toBeGreaterThan(0);
    expect(embedded.specs.some(spec => JSON.stringify(spec).includes("temporal"))).toBe(true);
  });

  it('shows the stat row under a distribution chart, with a median inside the range', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();

    const card = (fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p1"]');
    const stats = card?.querySelector('[data-testid="panel-stats"]');
    expect(stats).not.toBeNull();
    // parseFloat, not Number: a metric with a unit prints "0.4 mm".
    const figure = (label: string) =>
      parseFloat(stats?.querySelector(`[data-stat="${label}"] span:last-child`)?.textContent?.trim() ?? '');
    expect(stats?.querySelectorAll('[data-stat]')).toHaveLength(8);
    expect([...(stats?.querySelectorAll('[data-stat]') ?? [])].map((c) => c.getAttribute('data-stat'))).toEqual([
      'SCANS',
      'MEAN',
      'SD',
      '5TH PCT',
      'MEDIAN',
      '95TH PCT',
      'MIN',
      'MAX',
    ]);
    // Every one of those abbreviations carries its own sentence on hover.
    for (const cell of stats?.querySelectorAll('[data-stat] .stat-label') ?? []) {
      expect(cell.getAttribute('title')?.length ?? 0).toBeGreaterThan(0);
    }
    expect(figure('MIN')).toBeLessThanOrEqual(figure('MEDIAN'));
    expect(figure('MEDIAN')).toBeLessThanOrEqual(figure('MAX'));
    expect(card?.querySelector('[data-testid="panel-count"]')?.textContent).toContain(
      'scans with a value',
    );
    const coverage = (fixture.nativeElement as HTMLElement).querySelector('[data-panel-id="p5"]');
    expect(coverage?.querySelector('[data-testid="panel-stats"]')?.textContent).toContain('Total');
    const coverageCount = coverage?.querySelector('[data-testid="panel-count"]')?.textContent ?? '';
    expect(coverageCount).not.toContain('with a value');
    expect(coverageCount).toContain('scans');
    // "records" is gone from the card entirely: it was true of both views and
    // so told a reader nothing about either.
    expect(card?.textContent).not.toContain('records');
  });

  it('maximizes one panel and restores every panel on Escape', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const order = () =>
      [...host.querySelectorAll('[data-panel-id]')].map((card) => card.getAttribute('data-panel-id'));
    const button = (id: string, label: string) =>
      host.querySelector<HTMLButtonElement>(`[data-panel-id="${id}"] button[aria-label="${label}"]`);

    expect(order()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(button('p1', 'Move panel left')).toBeNull();
    button('p1', 'Maximize')?.click();
    await fixture.whenStable();
    expect(order()).toEqual(['p1']);

    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    await fixture.whenStable();
    expect(order()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('re-embeds nothing but the card it removed', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const embeds = embedded.specs.length;

    host.querySelector<HTMLButtonElement>('[data-panel-id="p2"] button[aria-label="Remove panel"]')?.click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();

    expect(host.querySelectorAll('[data-testid="panel-card"]')).toHaveLength(4);
    // A surviving panel's view tuple is untouched by a removal, so no card may
    // tear its Vega view down and build a new one.
    expect(embedded.specs.length).toBe(embeds);
  });

  it('opens the shared filter-slot drawer before creating a default card', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="add-panel"]')
      ?.click();
    await fixture.whenStable();
    const picker = document.querySelector('[data-testid="add-panel-picker"]')!;
    expect(picker.querySelector('app-column-picker')).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="panel-card"]')).toHaveLength(5);
    expect(picker.querySelectorAll('.column-picker-body > nav, .column-picker-body > .column-picker-columns, .column-picker-body > .column-picker-details')).toHaveLength(3);
    expect(picker.querySelector('[role="listbox"], [role="combobox"]')).toBeNull();
    const search = picker.querySelector<HTMLInputElement>('input[aria-label="X slot"]')!;
    search.value = 'efc';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    picker.querySelector<HTMLButtonElement>('[data-column-id="efc"]')!.click();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="panel-card"]')).toHaveLength(5);
    [...picker.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Create panel')!.click();
    await fixture.whenStable();
    let state!: State;
    const subscription = TestBed.inject(Graph).state$.subscribe(value => state = value);
    expect(state.panels.at(-1)).toMatchObject({ x: 'efc', y: null, form: 'histogram', series: [] });
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="panel-card"]')).toHaveLength(6);
    expect(document.querySelector('[data-testid="add-panel-picker"]')).toBeNull();
    subscription.unsubscribe();
  });

  it('derives the filter controls from the catalog, per modality and view', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const graph = TestBed.inject(Graph);

    // The default view is bold's canonical one, which is where HMC mode lives.
    expect(host.querySelector('[data-testid="filter-manufacturer"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="filter-canonical_hmc_mode"]')).not.toBeNull();
    // The long-tail fields are not in the primary row; they are in "More
    // filters", which is shut until it is asked for.
    expect(host.querySelector('[data-testid="filter-institution_name"]')).toBeNull();
    expect(host.querySelector('[data-testid="filter-manufacturer_raw"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="more-filters-toggle"]')?.click();
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="filter-institution_name"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="filter-manufacturer_raw"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="filter-protocol_name"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="more-filters-toggle"]')?.click();
    await fixture.whenStable();

    graph.form.patchValue({ view: 'raw' });
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="filter-manufacturer"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="filter-canonical_hmc_mode"]')).toBeNull();
  });

  it('renders a two-ended range control per numeric field of the view', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;

    // The ranges live in "More filters", which starts collapsed with nothing
    // filtered, so there is nothing to find until it is opened.
    expect(host.querySelector('[data-testid="more-filters"]')).toBeNull();
    expect(host.querySelector('[data-testid="numeric-echo_time-lo"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="more-filters-toggle"]')?.click();
    await fixture.whenStable();

    // The default dashboard opens on bold's canonical view, so both halves of
    // the control set are on screen: the fields every view has, and the two the
    // canonical tables alone carry.
    expect(host.querySelector('[data-testid="view-select"]')?.textContent).toContain('K4+');
    expect(host.querySelector('[data-testid="numeric-echo_time-lo"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="numeric-echo_time-hi"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="numeric-canonical_diameter-hi"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="numeric-canonical_group_rows-lo"]')).not.toBeNull();
    // The placeholders are the bounds the catalog reported, not guesses.
    expect(
      host
        .querySelector<HTMLInputElement>('[data-testid="numeric-canonical_group_rows-hi"]')
        ?.getAttribute('placeholder'),
    ).toBe('2950');

    TestBed.inject(Graph).form.patchValue({ view: 'raw' });
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="numeric-canonical_diameter-hi"]')).toBeNull();
    expect(host.querySelector('[data-testid="numeric-echo_time-hi"]')).not.toBeNull();
  });

  it('turns a typed bound into a between filter, and clearing it removes it', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const graph = TestBed.inject(Graph);
    host.querySelector<HTMLButtonElement>('[data-testid="more-filters-toggle"]')?.click();
    await fixture.whenStable();
    const box = host.querySelector<HTMLInputElement>('[data-testid="numeric-canonical_diameter-hi"]');
    let latest: State | null = null;
    const sub = graph.state$.subscribe((state) => (latest = state));

    const type = async (text: string) => {
      box!.value = text;
      box!.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fixture.whenStable();
    };

    // In state, and in the parameter the URL edge writes -- decoded back, so a
    // shared link really carries the range.
    const linked = () =>
      decodeUrlState(encodeUrlState(urlState(latest as State)))?.global.filters ?? [];

    await type('0.01');
    expect(graph.form.getRawValue().numeric['canonical_diameter'].hi).toBe(0.01);
    const expected = [{ field: 'canonical_diameter', op: 'between', lo: OPEN_LO, hi: 0.01 }];
    expect((latest as unknown as State).global.filters).toEqual(expected);
    expect(linked()).toEqual(expected);

    await type('');
    expect((latest as unknown as State).global.filters).toEqual([]);
    expect(linked()).toEqual([]);
    sub.unsubscribe();
  });

  it('clears every filter, including one the current view does not render', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const graph = TestBed.inject(Graph);
    graph.form.patchValue({
      view: 'k4plus',
      filters: { manufacturer: ['SIEMENS'], canonical_hmc_mode: ['volreg'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fixture.whenStable();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="clear-filters"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fixture.whenStable();
    const cleared = graph.form.getRawValue().filters;
    expect(Object.keys(cleared)).toContain('canonical_hmc_mode');
    expect(Object.values(cleared).every((values) => values.length === 0)).toBe(true);
    expect(graph.form.getRawValue().createdFrom).toBeNull();
  });

  it('adds a panel when the menu asks for one', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-testid="add-panel"]')?.click();
    await fixture.whenStable();
    const picker = document.querySelector('[data-testid="add-panel-picker"]')!;
    expect(picker.querySelectorAll('[data-family]').length).toBeGreaterThan(5);
    const slot = picker.querySelector<HTMLInputElement>('input[aria-label="X slot"]')!;
    slot.value = 'tsnr';
    slot.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    picker.querySelector<HTMLButtonElement>('[data-column-id="tsnr"]')!.click();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLButtonElement>('[data-testid="add-panel-picker"] button')].find(button => button.textContent?.trim() === 'Create panel')!.click();
    await fixture.whenStable();
    expect(host.querySelectorAll('[data-testid="panel-card"]')).toHaveLength(6);
    expect(host.querySelector('[data-panel-id="p6"] [aria-label="Form"]')?.textContent).toContain('Histogram');
  });
});

/* ---------------------------------------------------------------- failures */

/**
 * A mock whose panel queries fail and whose catalogue can be made to fail
 * once, so "Try again" has something to try.
 */
@Injectable()
class FlakyApi extends MockApi {
  /** How many more catalogue calls fail before one succeeds. */
  catalogFailures = 0;
  /** Whether every panel query fails. */
  panelsFail = true;

  override catalog(): Observable<CompletedCatalog> {
    if (this.catalogFailures > 0) {
      this.catalogFailures -= 1;
      return throwError(() => new Error('the server could not answer this query'));
    }
    return super.catalog();
  }

  override distribution(query: DistributionQuery): Observable<DistributionResult> {
    if (!this.panelsFail) return super.distribution(query);
    return throwError(() => new Error('the server could not answer this query'));
  }
}

describe('Dashboard when the server fails', () => {
  let api: FlakyApi;

  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    TestBed.configureTestingModule({
      imports: [Dashboard, WEB_ICONS],
      providers: [
        provideZonelessChangeDetection(),
        provideNativeDateAdapter(),
        provideRouter([{ path: '**', children: [] }]),
        FlakyApi,
        { provide: API, useExisting: FlakyApi },
        { provide: VEGA_EMBED, useValue: () => Promise.resolve(fakeEmbed()) },
      ],
    });
    api = TestBed.inject(FlakyApi);
  });

  const settle = async (fixture: { whenStable: () => Promise<unknown> }) => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
  };

  it('shows the server message and a "Try again" button in the failed panel', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const card = host.querySelector('[data-panel-id="p1"]');
    expect(card?.querySelector('[data-testid="panel-error-message"]')?.textContent?.trim()).toBe(
      'the server could not answer this query',
    );
    expect(card?.querySelector('[data-testid="panel-retry"]')).not.toBeNull();

    // And the retry really re-dispatches: with the server healthy again the
    // same button fills the panel in.
    api.panelsFail = false;
    card?.querySelector<HTMLButtonElement>('[data-testid="panel-retry"]')?.click();
    await settle(fixture);
    expect(host.querySelector('[data-panel-id="p1"] [data-testid="panel-error"]')).toBeNull();
  });

  it('stops claiming to load a catalogue that failed, and offers one retry', async () => {
    api.catalogFailures = 1;
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const status = () => host.querySelector('[data-testid="status-line"]')?.textContent ?? '';

    expect(status()).toContain("Couldn't load the metric catalogue");
    expect(status()).not.toContain('Loading the metric catalogue');

    host.querySelector<HTMLButtonElement>('[data-testid="retry-catalog"]')?.click();
    await settle(fixture);
    expect(status()).not.toContain("Couldn't load the metric catalogue");
  });
});

/* -------------------------------------------- the rest of the chrome, wired */

describe('Dashboard chrome', () => {
  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    embedded.specs = [];
    embedded.datasets = {};
    TestBed.configureTestingModule({
      imports: [Dashboard, WEB_ICONS],
      providers: [
        provideZonelessChangeDetection(),
        provideNativeDateAdapter(),
        provideRouter([{ path: '**', children: [] }]),
        MockApi,
        { provide: API, useExisting: MockApi },
        { provide: VEGA_EMBED, useValue: () => Promise.resolve(fakeEmbed()) },
      ],
    });
  });

  const settle = async (fixture: { whenStable: () => Promise<unknown> }) => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
  };

  it('names every landmark and puts the panel count inside one', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('header')?.getAttribute('aria-label')).toBe('Filters');
    expect(host.querySelector('main')?.getAttribute('aria-label')).toBe('Panels');
    // The add bar was a bare div, which is why axe reported "5 panels" as
    // content outside every landmark.
    const footer = host.querySelector('footer');
    expect(footer).not.toBeNull();
    expect(footer?.getAttribute('aria-label')).toBeTruthy();
    expect(footer?.querySelector('[data-testid="share-view"]')).not.toBeNull();
    expect(host.querySelector('[data-panel-id="p1"]')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('makes the explanatory tooltips reachable from the keyboard', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    // Every tooltip in the chrome used to hang off a plain span.
    expect(host.querySelector('[data-testid="data-date"]')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('[data-testid="quarantine-line"]')?.getAttribute('tabindex')).toBe(
      '0',
    );
    const fieldLabel = host.querySelector('[data-testid="filter-manufacturer"] .field-label span');
    expect(fieldLabel?.getAttribute('tabindex')).toBe('0');
  });

  it('groups modality and view apart from the filters, with the quarantine under them', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const primary = host.querySelector('[data-testid="primary-controls"]');
    expect(primary?.querySelector('[data-testid="modality-select"]')).not.toBeNull();
    expect(primary?.querySelector('[data-testid="view-select"]')).not.toBeNull();
    // A property of the view, so it lives beside the control that caused it
    // and not 1200px away in the status line.
    expect(primary?.querySelector('[data-testid="quarantine-line"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="status-line"] [data-testid="quarantine-line"]'),
    ).toBeNull();
    // And the filters are a separate group.
    expect(primary?.querySelector('[data-testid="filter-manufacturer"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="filter-group"] [data-testid="filter-manufacturer"]'),
    ).not.toBeNull();
  });

  it('leaves one short fact under "Scans shown" and nothing else', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    // The select is named for what it chooses between, and the only standing
    // text under it is what this view leaves out.
    expect(host.querySelector('#label-view')?.textContent?.trim()).toBe('Scans shown');
    const chip = host.querySelector('[data-testid="quarantine-line"]');
    expect(chip?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^[\d,]+ unstable groups left out$/,
    );
    // The uploads count and the definition are on hover, not on the page.
    const tip = chip?.getAttribute('ng-reflect-message') ?? chip?.getAttribute('aria-describedby');
    expect(host.querySelector('[data-testid="dedup-link"]')).toBeNull();
    expect(host.querySelector('[data-testid="view-help"]')?.textContent).not.toContain(
      'One record per scan',
    );
    void tip;

    // A view with nothing in quarantine says nothing at all.
    TestBed.inject(Graph).form.patchValue({ view: 'raw' });
    await settle(fixture);
    expect(host.querySelector('[data-testid="quarantine-line"]')).toBeNull();
  });

  it('drops the page tagline and keeps the heading', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('MRIQC population');
    expect(host.textContent).not.toContain('Visual statistics over every image-quality metric');
  });

  it('gives every card a sentence about this data, and no taxonomy path', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const meaning = (id: string) =>
      host
        .querySelector(`[data-panel-id="${id}"] [data-testid="panel-meaning"]`)
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? '';
    // No count in the sentence: the line underneath is the count, and saying
    // 778,075 in both printed the same figure twice.
    expect(meaning('p1')).toMatch(/^How many scans fall in each range of .+\.$/);
    expect(meaning('p1')).not.toMatch(/\d/);
    expect(meaning('p5')).toMatch(/^Scans uploaded per \w+\.$/);
    // The corpus is named once, on the count line.
    const count = (id: string) =>
      host
        .querySelector(`[data-panel-id="${id}"] [data-testid="panel-count"]`)
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? '';
    expect(count('p1')).toMatch(/^[\d,]+ deduplicated BOLD scans with a value$/);
    expect(count('p5')).toMatch(/^[\d,]+ deduplicated BOLD scans$/);
    // The taxonomy path it replaced is in the info popover now, nowhere else.
    expect(meaning('p1')).not.toContain('Motion / Framewise displacement');
  });

  it('writes a category value the way its own field writes it', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host
      .querySelector<HTMLElement>('[data-testid="filter-canonical_hmc_mode"] mat-select')
      ?.click();
    await fixture.whenStable();
    const options = [...document.querySelectorAll('mat-option')].map(
      (o) => o.textContent?.trim() ?? '',
    );
    expect(options.some((text) => text.startsWith('AFNI (3dvolreg)'))).toBe(true);
    expect(options.some((text) => text.startsWith('FSL (MCFLIRT)'))).toBe(true);
    expect(options.some((text) => text === 'afni')).toBe(false);
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    await fixture.whenStable();
  });

  it('links About and view help to real routes while preserving dashboard state', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const about = host.querySelector<HTMLAnchorElement>('[data-testid="about-open"]');
    expect(about?.getAttribute('href')).toBe('/about');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="quarantine-line"]')?.getAttribute('href')).toContain('#dedup');
  });

  it('puts the catalogue prose behind an info button on every metric card', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const info = host.querySelector<HTMLButtonElement>(
      '[data-panel-id="p1"] [data-testid="metric-title"]',
    );
    expect(info).not.toBeNull();
    info?.click();
    await fixture.whenStable();
    expect(
      document.querySelector('[data-testid="metric-info-description"]')?.textContent?.trim(),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid="metric-info-family"]')?.textContent?.trim(),
    ).toBeTruthy();
    expect(document.querySelector('[data-testid="metric-popover"] app-column-picker')).not.toBeNull();
    expect(document.querySelector('[aria-label="Y slot (optional)"]')).not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>('[data-testid="metric-popover"] a')?.href).toContain('mriqc.readthedocs.io');
    // The old caption info icon has left the face.
    expect(host.querySelector('[data-panel-id="p5"] [data-testid="metric-info"]')).toBeNull();
  });

  it('discloses the clip the chart is actually drawing', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const notes = (id: string) =>
      [...host.querySelectorAll(`[data-panel-id="${id}"] [data-testid="panel-note"]`)].map((n) =>
        n.textContent?.replace(/\s+/g, ' ').trim(),
      );
    // Every card opens clipped to p01-p99, so saying so on all five of them
    // reported only that nobody had changed anything. The clip is a chip now,
    // and only when it is not the default.
    expect(notes('p1')).toEqual([]);
    expect(host.querySelector('[data-panel-id="p1"] [data-testid="panel-clip"]')).toBeNull();
    TestBed.inject(Graph).dispatch({ t: 'setPanelOptions', id: 'p1', options: { clip: 'none' } });
    await settle(fixture);
    expect(
      host.querySelector('[data-panel-id="p1"] [data-testid="panel-clip"]')?.textContent?.trim(),
    ).toBe('Full range');
    // Coverage clips nothing, so it never carries the chip.
    expect(host.querySelector('[data-panel-id="p5"] [data-testid="panel-clip"]')).toBeNull();
  });

  it('spaces the middle dot on both sides, so it is a separator and not a suffix', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    TestBed.inject(Graph).dispatch({
      t: 'brush',
      from: 'p1',
      metric: asColumnId('fd_mean'),
      range: [0.2, 0.6],
    });
    await settle(fixture);
    // The whole caption line, with the non-breaking space read as a space: the
    // dot used to be glued to the word before it -- "scans with a value\u00b7
    // filtered by brush" -- because Angular drops the whitespace-only text node
    // between two control-flow blocks.
    const line = host
      .querySelector('[data-panel-id="p2"] [data-testid="panel-note"]')
      ?.parentElement?.textContent?.replace(/\u00a0/g, ' ');
    expect(line).toContain(' \u00b7 filtered by brush');
    expect(line).not.toMatch(/\S\u00b7/);
  });

  it('shows a brush as an amber chip that clears it, and marks the panels it narrows', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const graph = TestBed.inject(Graph);
    expect(host.querySelector('[data-testid="brush-chip"]')).toBeNull();

    graph.dispatch({ t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0.2, 0.6] });
    await settle(fixture);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="brush-chip"]');
    // "Brushed: " and not a bare metric name: in the status line, beside "Data
    // from 6 Aug 2026", a reader took the chip for a stray label.
    // The metric's short name, because the chip is chip-sized.
    expect(chip?.textContent?.replace(/\s+/g, ' ')).toContain('Brushed: FD mean ');
    expect(chip?.textContent?.replace(/\s+/g, ' ')).toContain('0.2–0.6');
    // It sits with the other filter controls now, in the action cluster at the
    // end of the row rather than in the status line 1200px away.
    expect(chip?.closest('[data-testid="filter-group"]')).not.toBeNull();
    expect(chip?.closest('[data-testid="filter-actions"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="status-line"] [data-testid="brush-chip"]')).toBeNull();
    const notes = (id: string) =>
      [...host.querySelectorAll(`[data-panel-id="${id}"] [data-testid="panel-note"]`)].map((n) =>
        n.textContent?.replace(/\s+/g, ' ').trim(),
      );
    expect(notes('p1')).toContain('· brush source');
    expect(notes('p2')).toContain('· filtered by brush');

    chip?.click();
    await settle(fixture);
    expect(host.querySelector('[data-testid="brush-chip"]')).toBeNull();
  });

  it('clears the brush along with the filters', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const graph = TestBed.inject(Graph);
    let latest: State | null = null;
    const sub = graph.state$.subscribe((state) => (latest = state));

    graph.dispatch({ t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0.2, 0.6] });
    await settle(fixture);
    expect((latest as unknown as State).selections).not.toEqual([]);

    host.querySelector<HTMLButtonElement>('[data-testid="clear-filters"]')?.click();
    await settle(fixture);
    // The one thing on the page that "Clear filters" used to leave in force.
    expect((latest as unknown as State).selections).toEqual([]);
    sub.unsubscribe();
  });

  it('offers an undo after a removal, and brings the same panel back', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const ids = () =>
      [...host.querySelectorAll('[data-panel-id]')].map((c) => c.getAttribute('data-panel-id'));
    const before = ids();

    host
      .querySelector<HTMLButtonElement>('[data-panel-id="p2"] button[aria-label="Remove panel"]')
      ?.click();
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="undo-snackbar"]')?.textContent).toContain('Removed');
    expect(host.querySelectorAll('[data-testid="panel-card"]')).toHaveLength(4);

    host.querySelector<HTMLButtonElement>('[data-testid="undo-remove"]')?.click();
    await settle(fixture);
    // Same id, same place.
    expect(ids()).toEqual(before);
    expect(host.querySelector('[data-testid="undo-snackbar"]')).toBeNull();
  });

  it('gives Raw records a total, a horizontal scroller and a column chooser', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLElement>('[data-panel-id="p1"] [aria-label="Form"] .mat-mdc-select-trigger')!.click();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLElement>('mat-option')].find(option=>option.textContent?.trim().startsWith('Table'))!.click();
    await settle(fixture);

    const card = host.querySelector('[data-panel-id="p1"]');
    // "100 rows loaded" said nothing about what it was 100 of.
    expect(card?.querySelector('[data-testid="panel-shown"]')?.textContent).toMatch(
      /Showing [\d,]+ of [\d,]+ scans/,
    );
    expect(card?.querySelector('[data-testid="panel-meaning"]')?.textContent?.trim()).toBe(
      'The individual scans behind these charts, most recent first.',
    );
    expect(card?.querySelector('[data-testid="sample-scroll"]')).not.toBeNull();

    const chooser = card?.querySelector<HTMLButtonElement>('[data-testid="column-chooser"]');
    expect(chooser?.textContent).toContain('5 of');
    chooser?.click();
    await fixture.whenStable();
    const boxes = document.querySelectorAll<HTMLInputElement>(
      '[data-testid="column-chooser-menu"] input[type="checkbox"]',
    );
    expect(boxes.length).toBeGreaterThan(5);
    expect([...boxes].filter((box) => box.checked)).toHaveLength(5);

    // Every header carries its full text, however narrow the column.
    const headers = card?.querySelectorAll('[data-testid="sample-scroll"] [title]') ?? [];
    expect(headers.length).toBeGreaterThan(0);
  });

  it('sizes the stat row so the number outweighs its label', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const stat = (fixture.nativeElement as HTMLElement).querySelector('[data-stat="MEAN"]');
    const [label, value] = stat?.querySelectorAll('span') ?? [];
    // 10px/500 secondary ink over 15px/600 tabular, not 11px/600 over 13px/400.
    // The sizes themselves live in `styles.css`, which jsdom never loads, so
    // this holds the two classes that carry them.
    expect(label.className).toContain('stat-label');
    expect(value.className).toContain('stat-value');
    // The row is a grid inside a query container, not a wrapping flex row:
    // flex wrap stranded MIN and MAX on a short second line.
    const row = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="panel-stats"]');
    expect(row?.className).toContain('stat-row');
    expect(row?.parentElement?.className).toContain('stat-row-container');
  });

  it('keeps ordinary cards one column wide', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      'app-panel-card',
    );
    // jsdom answers every media query with false, so this is the one-column
    // case: nothing spans. The arithmetic itself is `lastCardSpan`'s own test.
    expect(cards[cards.length - 1].style.gridColumn).toBe('');
    expect(cards[cards.length - 1].style.height).toBe('544px');
  });
});

describe('Dashboard on a phone', () => {
  /** jsdom answers every query; this one says yes to the phone breakpoint. */
  function phoneMatchMedia(query: string) {
    return {
      matches: query === PHONE_QUERY,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    };
  }

  let original: typeof window.matchMedia;

  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { writable: true, value: phoneMatchMedia });
    TestBed.configureTestingModule({
      imports: [Dashboard, WEB_ICONS],
      providers: [
        provideZonelessChangeDetection(),
        provideNativeDateAdapter(),
        provideRouter([{ path: '**', children: [] }]),
        MockApi,
        { provide: API, useExisting: MockApi },
        { provide: VEGA_EMBED, useValue: () => Promise.resolve(fakeEmbed()) },
      ],
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: original });
  });

  it('collapses the whole filter bar behind one button, keeping modality and view', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;

    // At 390px the bar was 835px tall: a full screen of controls before a
    // single number.
    expect(host.querySelector('[data-testid="filter-group"]')).toBeNull();
    expect(host.querySelector('[data-testid="modality-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="view-select"]')).not.toBeNull();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="filters-toggle"]');
    expect(toggle?.textContent).toContain('Filters (0 active)');
    toggle?.click();
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="filter-group"]')).not.toBeNull();
  });

  it('keeps the brush beside the collapsed button, and counts it as active', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    TestBed.inject(Graph).dispatch({
      t: 'brush',
      from: 'p1',
      metric: asColumnId('fd_mean'),
      range: [0.2, 0.6],
    });
    await fixture.whenStable();

    // Behind the toggle it would be the one filter with no visible way back.
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="brush-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.closest('[data-testid="filter-group"]')).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="filters-toggle"]')?.textContent,
    ).toContain('Filters (1 active)');

    // Opening the group must not render a second one.
    host.querySelector<HTMLButtonElement>('[data-testid="filters-toggle"]')?.click();
    await fixture.whenStable();
    expect(host.querySelectorAll('[data-testid="brush-chip"]')).toHaveLength(1);
  });
});
