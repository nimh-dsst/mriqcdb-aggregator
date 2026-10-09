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
import { Graph } from '../graph/graph';
import { resetPanelViewMemo } from '../view/panel-view';
import { urlState } from '../graph/url';
import type { State } from '../graph/state';
import { decodeUrlState, encodeUrlState } from '../graph/url';
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

/**
 * Open the cohort editor the way a reader reaches it before any cohort exists:
 * a panel's "Compare with… / New cohort…".
 *
 * The chip row -- and with it "Add one by hand" -- only appears once there is a
 * cohort to show, so this is the entry point on a fresh dashboard.
 */
async function openEditorFromPanel(fixture: {
  nativeElement: unknown;
  whenStable: () => Promise<unknown>;
}): Promise<void> {
  const host = fixture.nativeElement as HTMLElement;
  const settleHere = async () => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    TestBed.tick();
    await fixture.whenStable();
  };
  host.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')?.click();
  await settleHere();
  document.querySelector<HTMLButtonElement>('[data-testid="compare-with-new"]')?.click();
  await settleHere();
}

/* -------------------------------------------------------- the rendered bar */

describe('the cohort bar and the comparison card', () => {
  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    // A MatDialog renders into an overlay container attached to the document,
    // not into the fixture's view tree, and a container left behind by an
    // earlier test keeps answering `document.querySelector` -- so the next test
    // would type into a dialog whose component is long gone.
    for (const stale of document.querySelectorAll('.cdk-overlay-container')) stale.remove();
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

  /** Let the mock answer every outstanding query and the view settle. */
  /**
   * Let the mock answer every outstanding query and the view settle.
   *
   * `TestBed.tick()` as well as the fixture's own stabilisation: the editor is
   * a dialog, attached to the ApplicationRef through the overlay rather than to
   * this fixture's view tree, so a signal written inside it is not flushed by
   * `fixture.whenStable()` alone.
   */
  async function settle(fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    TestBed.tick();
    await fixture.whenStable();
  }

  it('shows no cohort row at all until there is a cohort to show', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    // "This dashboard" and "Whole population" always exist, so a chip apiece
    // was two rows of furniture on every dashboard that had no cohorts. They
    // are still offered where a cohort is *chosen* -- a panel's menu.
    expect(host.querySelector('[data-testid="cohort-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="cohort-chip-current"]')).toBeNull();
    // And the one-click way to make one is in the filter actions, always.
    expect(host.querySelector('[data-testid="cohort-save-current"]')).not.toBeNull();
  });

  it('shows a chip per user cohort, with edit and remove', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const graph = TestBed.inject(Graph);
    graph.dispatch({
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: 'Philips',
        color: 2,
        source: 'population',
        view: 'k4plus',
        filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['Philips'] }],
        selections: [],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const chip = host.querySelector('[data-testid="cohort-chip-c1"]');
    expect(chip?.getAttribute('data-cohort-name')).toBe('Philips');
    expect(host.querySelector('[data-testid="cohort-edit-c1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cohort-remove-c1"]')).not.toBeNull();
  });

  it('removes a cohort from the bar when its chip asks', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const graph = TestBed.inject(Graph);
    graph.dispatch({
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: 'Philips',
        color: 2,
        source: 'population',
        view: 'k4plus',
        filters: [],
        selections: [],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-testid="cohort-remove-c1"]')?.click();
    await settle(fixture);
    expect(host.querySelector('[data-testid="cohort-chip-c1"]')).toBeNull();
  });

  it('offers "Compare with" in a distribution panel’s options', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host
      .querySelector<HTMLButtonElement>('[aria-label="Panel options"]')
      ?.click();
    await settle(fixture);
    // "Whole population" and "New cohort…" -- but not "This dashboard", which
    // is the panel itself.
    expect(document.querySelector('[data-testid="compare-with-all"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="compare-with-new"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="compare-with-current"]')).toBeNull();
  });

  it('converts a distribution panel into a two-cohort comparison', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="compare-with-all"]')?.click();
    await settle(fixture);

    const card = host.querySelector('[data-panel-id="p1"]');
    expect(card?.getAttribute('data-panel-kind')).toBe('comparison');
    // The comparison opens on the smoothed density, so the sentence is the
            // density one -- which still says how many cohorts are on the chart.
    expect(card?.querySelector('[data-testid="panel-meaning"]')?.textContent).toContain(
      'across 2 cohorts',
    );
    // The count line is one `n` per cohort, not one total: a single figure
    // would be the sum of cohorts that overlap.
    const counts = card?.querySelector('[data-testid="panel-cohort-counts"]')?.textContent ?? '';
    expect(counts).toContain('This dashboard');
    expect(counts).toContain('Whole population');
    expect(card?.querySelector('[data-testid="panel-stats"]')).toBeNull();
  });

  it('renders a row per cohort and a differences row for exactly two', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="compare-with-all"]')?.click();
    await settle(fixture);

    const card = host.querySelector('[data-panel-id="p1"]') as HTMLElement;
    const table = card.querySelector('[data-testid="comparison-table"]');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(card.querySelector('[data-testid="comparison-row-current"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="comparison-row-all"]')).not.toBeNull();
    const differences = card.querySelector('[data-testid="comparison-differences"]');
    expect(differences).not.toBeNull();
    // One differences row -- the non-reference cohort -- with its four figures.
    expect(differences?.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(
      [...(differences?.querySelectorAll('[data-stat]') ?? [])].map((cell) =>
        cell.getAttribute('data-stat'),
      ),
    ).toEqual(['MEDIAN SHIFT', 'AS SHARE OF IQR', 'MEAN SHIFT', 'KS DISTANCE']);
  });

  it('drops the differences row at a third cohort', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const graph = TestBed.inject(Graph);
    graph.dispatch({
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: 'Philips',
        color: 2,
        source: 'population',
        view: 'k4plus',
        filters: [],
        selections: [],
      },
    });
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'all' });
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'c1' });
    await settle(fixture);
    const card = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-panel-id="p1"]',
    ) as HTMLElement;
    expect(card.querySelectorAll('[data-testid="comparison-table"] tbody tr')).toHaveLength(3);
    // The differences block stays and grows: one row per non-reference cohort,
    // all against the same reference, which the reader can change.
    const differences = card.querySelector('[data-testid="comparison-differences"]');
    expect(differences).not.toBeNull();
    expect(differences?.querySelectorAll('tbody tr')).toHaveLength(2);
    // Past two cohorts the all-pairs table is offered, because a single
    // reference cannot say which two are furthest apart.
    expect(card.querySelector('[data-testid="all-pairs-toggle"]')).not.toBeNull();
  });

  it('colours each row with its cohort’s hue, which is also the chip’s', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const graph = TestBed.inject(Graph);
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'all' });
    await settle(fixture);
    const card = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-panel-id="p1"]',
    ) as HTMLElement;
    const colours = [...card.querySelectorAll('[data-testid^="comparison-row-"] th')].map(
      (cell) => (cell as HTMLElement).style.borderLeftColor,
    );
    // The first two palette slots, which `current` and `all` hold for the life
    // of the dashboard: slot 0 is the blue a single-series histogram draws.
    expect(colours).toEqual(['rgb(0, 114, 178)', 'rgb(0, 158, 115)']);
  });

  it('reverts to a distribution panel when a cohort is removed from a pair', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const graph = TestBed.inject(Graph);
    graph.dispatch({
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: 'Philips',
        color: 2,
        source: 'population',
        view: 'k4plus',
        filters: [],
        selections: [],
      },
    });
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'c1' });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-panel-id="p1"]')?.getAttribute('data-panel-kind')).toBe(
      'comparison',
    );
    host.querySelector<HTMLButtonElement>('[data-testid="cohort-remove-c1"]')?.click();
    await settle(fixture);
    const card = host.querySelector('[data-panel-id="p1"]');
    // A comparison of one cohort *is* a distribution, so the card stays and
    // keeps its metric rather than becoming an empty panel.
    expect(card?.getAttribute('data-panel-kind')).toBe('distribution');
    expect(card?.querySelector('[data-testid="panel-stats"]')).not.toBeNull();
    expect(card?.querySelector('[data-testid="comparison-table"]')).toBeNull();
  });

  it('draws the cohorts into one named dataset with a declared colour scale', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    embedded.specs = [];
    embedded.datasets = {};
    const graph = TestBed.inject(Graph);
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'all' });
    await settle(fixture);
    const comparison = embedded.specs.find((spec) =>
      JSON.stringify(spec).includes('"name":"cohorts"'),
    );
    expect(comparison).toBeDefined();
    const text = JSON.stringify(comparison);
    // The domain is declared, so a cohort whose query has not landed keeps its
    // hue and its legend slot instead of handing them to the next one along --
    // and it is keyed on the id, because two cohorts can share a name.
    expect(text).toContain('"domain":["current","all"]');
    expect(text).toContain('"title":"Scans"');
  });

  it('opens the editor from the bar, and closes it on cancel', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    // The chip row, and with it "Add one by hand", appears once a cohort does.
    host.querySelector<HTMLButtonElement>('[data-testid="cohort-save-current"]')?.click();
    await settle(fixture);
    host.querySelector<HTMLButtonElement>('[data-testid="cohort-add"]')?.click();
    // The editor is a lazily imported chunk, so the dialog opens a microtask
    // later than the click.
    await settle(fixture);
    const dialog = document.querySelector('[data-testid="cohort-editor"]');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[data-testid="cohort-editor-title"]')?.textContent).toContain(
      'New cohort',
    );
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')?.click();
    await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-editor"]')).toBeNull();
    // Cancelling is not a command: the cohort list is the one cohort it was.
    expect(host.querySelectorAll('[data-testid^="cohort-chip-"]')).toHaveLength(1);
  });

  it('creates a cohort the editor describes, seeded from this dashboard', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    await openEditorFromPanel(fixture);
    const name = document.querySelector<HTMLInputElement>('[data-testid="cohort-name"]');
    expect(name).not.toBeNull();
    // Prefilled with the name the one-click path would give this dashboard, so
    // the box is a correction rather than a question.
    expect(name?.value).toBe('K4+ · all');
    name!.value = 'Siemens 3T';
    name!.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-color-4"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')?.click();
    await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-editor"]')).toBeNull();
    const chip = host.querySelector('[data-testid="cohort-chip-c1"]');
    expect(chip?.getAttribute('data-cohort-name')).toBe('Siemens 3T');
  });

  it('converts the panel that asked for "New cohort…" once the cohort exists', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="compare-with-new"]')?.click();
    await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-editor"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')?.click();
    await settle(fixture);
    const card = host.querySelector('[data-panel-id="p1"]');
    // Two commands, one dialog: the editor minted the id, so it can name the
    // cohort the panel is being pointed at.
    expect(card?.getAttribute('data-panel-kind')).toBe('comparison');
    const rows = card?.querySelectorAll('[data-testid="comparison-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(card?.querySelector('[data-testid="comparison-row-current"]')).not.toBeNull();
    expect(card?.querySelector('[data-testid="comparison-row-c1"]')).not.toBeNull();
  });

  it('switches to the time-span comparison inside the editor', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    await openEditorFromPanel(fixture);
    // A mode of this dialog, not a third button on a 28px chip: it is this
    // cohort copied across two date ranges, so everything above is the input.
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-compare-spans"]')?.click();
    await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-editor-title"]')?.textContent).toContain(
      'Compare time spans',
    );
    expect(document.querySelector('[data-testid="span-metric"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="span-a-start"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="span-b-end"]')).not.toBeNull();
    // Save is refused until both spans are filled: two cohorts differing in
    // nothing would be a comparison of a cohort with itself.
    const save = document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]');
    expect(save?.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')?.click();
    await settle(fixture);
  });

  it('round-trips cohorts and a comparison panel through a shared link', async () => {
    const first = TestBed.createComponent(Dashboard);
    await settle(first);
    const graph = TestBed.inject(Graph);
    // The URL edge goes through the router, which in a TestBed does not write
    // `window.location`, so the link is built from the same projection the edge
    // uses rather than read back off the address bar.
    let latest: State | null = null;
    const sub = graph.state$.subscribe((state) => {
      latest = state;
    });
    graph.dispatch({
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: 'Siemens 3T',
        color: 4,
        source: 'population',
        view: 'k4plus',
        filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
        selections: [],
      },
    });
    graph.dispatch({ t: 'convertToComparison', panelId: 'p1', with: 'c1' });
    graph.dispatch({ t: 'setPanelReference', id: 'p1', cohort: 'c1' });
    await settle(first);
    sub.unsubscribe();
    const encoded = encodeUrlState(urlState(latest as unknown as State));
    const decoded = decodeUrlState(encoded);
    expect(decoded?.cohorts.map((c) => c.name)).toEqual(['Siemens 3T']);
    expect(decoded?.panels[0]).toMatchObject({
      x: 'fd_mean',
      cohorts: ['current', 'c1'],
      reference: 'c1',
    });

    // A new dashboard opened on that link, as a recipient would.
    first.destroy();
    resetPanelViewMemo();
    window.history.replaceState({}, '', `/?s=${encoded}`);
    const second = TestBed.createComponent(Dashboard);
    await settle(second);
    const host = second.nativeElement as HTMLElement;
    expect(
      host.querySelector('[data-testid="cohort-chip-c1"]')?.getAttribute('data-cohort-name'),
    ).toBe('Siemens 3T');
    const card = host.querySelector('[data-panel-id="p1"]');
    expect(card?.getAttribute('data-panel-kind')).toBe('comparison');
    expect(card?.querySelector('[data-testid="comparison-row-c1"]')).not.toBeNull();
    // The colour the cohort was created with, not one re-ranked on arrival.
    expect(
      (card?.querySelector('[data-testid="comparison-row-c1"] th') as HTMLElement | null)?.style
        .borderLeftColor,
    ).toBe('rgb(204, 121, 167)');
  });
});

describe('saving the dashboard as a cohort', () => {
  beforeEach(() => {
    resetPanelViewMemo();
    window.history.replaceState({}, '', '/');
    // A MatDialog renders into an overlay container attached to the document,
    // not into the fixture's view tree, and a container left behind by an
    // earlier test keeps answering `document.querySelector` -- so the next test
    // would type into a dialog whose component is long gone.
    for (const stale of document.querySelectorAll('.cdk-overlay-container')) stale.remove();
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

  /**
   * Let the mock answer every outstanding query and the view settle.
   *
   * `TestBed.tick()` as well as the fixture's own stabilisation: the editor is
   * a dialog, attached to the ApplicationRef through the overlay rather than to
   * this fixture's view tree, so a signal written inside it is not flushed by
   * `fixture.whenStable()` alone.
   */
  async function settle(fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    TestBed.tick();
    await fixture.whenStable();
  }

  it('adds a named cohort in one click, with no dialog', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-testid="cohort-save-current"]')?.click();
    await settle(fixture);
    // No dialog: the dashboard already is the selection, and the name composes
    // from the view, the filters and the brush.
    expect(document.querySelector('[data-testid="cohort-editor"]')).toBeNull();
    const chip = host.querySelector('[data-testid="cohort-chip-c1"]');
    expect(chip?.getAttribute('data-cohort-name')).toBe('K4+ \u00b7 all');
  });

  it('names the second snapshot apart from the first', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const save = () =>
      host.querySelector<HTMLButtonElement>('[data-testid="cohort-save-current"]')?.click();
    save();
    await settle(fixture);
    save();
    await settle(fixture);
    const names = ['c1', 'c2'].map((id) =>
      host
        .querySelector('[data-testid="cohort-chip-' + id + '"]')
        ?.getAttribute('data-cohort-name'),
    );
    expect(names).toEqual(['K4+ \u00b7 all', 'K4+ \u00b7 all (2)']);
  });

  it('offers the same one click inside a comparison panel\u2019s menu', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Panel options"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="compare-with-saved-current"]')?.click();
    await settle(fixture);
    const card = host.querySelector('[data-panel-id="p1"]');
    // The cohort was created *and* the panel pointed at it, in one action.
    expect(card?.getAttribute('data-panel-kind')).toBe('comparison');
    expect(card?.querySelector('[data-testid="comparison-row-c1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cohort-chip-c1"]')).not.toBeNull();
  });

  it('starts from this dashboard by default, and says so', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    await openEditorFromPanel(fixture);
    // The first control, because it overwrites every field under it.
    expect(
      document.querySelector('[data-testid="start-current"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    // And the saved-cohort select is not on screen until that branch is taken.
    expect(document.querySelector('[data-testid="cohort-duplicate"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="start-cohort"]')?.click();
    await settle(fixture);
    expect(document.querySelector('[data-testid="cohort-duplicate"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')?.click();
    await settle(fixture);
  });

  it('clears the fields when it starts from blank, and names the result', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    // A filtered dashboard, so "blank" has something visible to clear.
    const graph = TestBed.inject(Graph);
    graph.form.patchValue({ filters: { manufacturer: ['Siemens'] } });
    await settle(fixture);
    await openEditorFromPanel(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="start-blank"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')?.click();
    await settle(fixture);
    const chip = host.querySelector('[data-testid="cohort-chip-c1"]');
    // Blank means no filters, and the name says so rather than naming the
    // dashboard's manufacturer.
    expect(chip?.getAttribute('data-cohort-name')).toContain('all');
    expect(chip?.getAttribute('data-cohort-name')).not.toContain('Siemens');
  });

  it('keeps the name the reader typed, and tracks the fields until they do', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    await openEditorFromPanel(fixture);
    // Untouched: switching the start overwrites the name along with the fields.
    document.querySelector<HTMLButtonElement>('[data-testid="start-blank"]')?.click();
    await settle(fixture);
    const typed = document.querySelector<HTMLInputElement>('[data-testid="cohort-name"]');
    typed!.value = 'My cohort';
    typed!.dispatchEvent(new Event('input'));
    await settle(fixture);
    // Touched: nothing overwrites it now, not even a change of start.
    document.querySelector<HTMLButtonElement>('[data-testid="start-current"]')?.click();
    await settle(fixture);
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')?.click();
    await settle(fixture);
    expect(
      host.querySelector('[data-testid="cohort-chip-c1"]')?.getAttribute('data-cohort-name'),
    ).toBe('My cohort');
  });

  it('refuses to create a cohort with no name', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    await openEditorFromPanel(fixture);
    const typed = document.querySelector<HTMLInputElement>('[data-testid="cohort-name"]');
    typed!.value = '   ';
    typed!.dispatchEvent(new Event('input'));
    await settle(fixture);
    // A cohort with no name is a legend entry nobody can read.
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="cohort-save"]')?.disabled,
    ).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')?.click();
    await settle(fixture);
  });

  it('previews how many scans the draft matches', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    await openEditorFromPanel(fixture);
    // The dialog asks for this itself -- a debounced, cancelled, component-local
    // request that never enters state -- so the reader can see what they are
    // about to save before they save it.
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_DEBOUNCE_MS + MOCK_LATENCY_MS * 4));
    TestBed.tick();
    await fixture.whenStable();
    const preview = document.querySelector('[data-testid="cohort-preview"]')?.textContent ?? '';
    expect(preview).toMatch(/[\u2248~]\s*[\d,]+/);
    document.querySelector<HTMLButtonElement>('[data-testid="cohort-cancel"]')?.click();
    await settle(fixture);
  });
});
