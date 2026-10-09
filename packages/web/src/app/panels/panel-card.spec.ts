import type { PanelView } from '../view/panel-view';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideZonelessChangeDetection } from '@angular/core';
import { asColumnId } from '@mriqc/shared';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WEB_ICONS } from '../app.config';
import { Theme } from '../chrome/theme';
import { Graph } from '../graph/graph';
import { initialState } from '../graph/reducer';
import { defaultPanelOptions, type Panel, type State } from '../graph/state';
import { PanelCard } from './panel-card';
import { decodeUrlState } from '../graph/url';
import { panelCohorts } from '../graph/queries';

const makePanel = (overrides: Partial<Panel> = {}): Panel => ({
  id: 'panel-1',
  x: asColumnId('snr'),
  y: null,
  form: 'histogram',
  series: [],
  options: defaultPanelOptions(),
  cursors: [],
  reference: 'current',
  ...overrides,
});

const panelView = {
  title: 'Signal-to-noise ratio',
  n: 12,
  countLabel: '12 scans',
  stats: [],
  meaning: 'Signal-to-noise ratio by cohort.',
  notes: [],
  metricHelp: null,
  cohorts: [
    { id: 'current', name: 'Current', color: '#1f77b4', n: 12, editable: false },
    { id: 'comparison', name: 'Comparison', color: '#ff7f0e', n: 8, editable: false },
  ],
  comparison: null,
  analysisHeaders: [],
  analysisRows: [],
  status: { kind: 'loading' },
  table: null,
  specKey: 'test',
  spec: { data: { name: 'series' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' } } },
  live: false,
  datasets: {},
} satisfies Partial<PanelView>;

const makeState = (panel: Panel): State => ({
  ...initialState,
  panels: [panel],
  global: { ...initialState.global, modality: 'bold', view: 'raw', filters: [] },
  catalog: null,
  cohorts: [],
  study: 'none',
});

const create = (panel: Panel) => {
  const graph = {
    state$: new BehaviorSubject(makeState(panel)),
    panelView$: () => of({ ...panelView, panel }),
    dispatch: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [
      PanelCard,

      WEB_ICONS,
    ],
    providers: [provideZonelessChangeDetection(),
      { provide: Graph, useValue: graph },
      { provide: Theme, useValue: { mode: () => 'light' } },
      { provide: MatDialog, useValue: { open: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(PanelCard);
  fixture.componentRef.setInput('panelId', panel.id);
  fixture.detectChanges();
  return fixture;
};

const formOptionLabels = (panel: Panel): readonly string[] => {
  const fixture = create(panel);
  const trigger = fixture.nativeElement.querySelector(
    '[aria-label="Form"] .mat-mdc-select-trigger',
  ) as HTMLElement;
  trigger.click();
  fixture.detectChanges();
  const overlay = TestBed.inject(OverlayContainer).getContainerElement();
  return Array.from(overlay.querySelectorAll('mat-option')).map(
    (option) => option.textContent?.trim() ?? '',
  );
};

describe('PanelCard', () => {
  it('seeds Save as group with the selected field values and filters Only this group', async () => {
    const panel = makePanel({ series: [{ kind: 'values', field: asColumnId('manufacturer'), values: ['Siemens'] }] });
    const fixture = create(panel);
    const cohort = panelCohorts(makeState(panel), panel)[0];
    const open = vi.spyOn(TestBed.inject(MatDialog), 'open');
    await fixture.componentInstance.groupAction({ id: cohort.id, action: 'save' });
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ data: {
      mode: 'create', seed: expect.objectContaining({ filters: [{ field: 'manufacturer', op: 'in', values: ['Siemens'] }] }), convertPanel: panel.id,
    } }));
    await fixture.componentInstance.groupAction({ id: cohort.id, action: 'only' });
    expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith({ t: 'setFilters', filters: [{ field: 'manufacturer', op: 'in', values: ['Siemens'] }] });
  });
  it.each(['x', 'y', 'color'] as const)('opens %s element controls and dispatches its scale', async axis => {
    const fixture = create(makePanel({ form: 'heatmap', y: asColumnId('fd_mean') }));
    fixture.nativeElement.querySelector('[data-testid="panel-card"]').dispatchEvent(new CustomEvent('elementcontext', {
      bubbles: true, detail: { axis, x: 20, y: 30 },
    }));
    fixture.detectChanges(); await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const select = overlay.querySelector<HTMLSelectElement>(`[aria-label="${axis.toUpperCase()} scale"]`)!;
    expect(Array.from(select.options, option => option.text)).toEqual(axis === 'color' ? ['Linear', 'Log', 'Sqrt'] : ['Linear', 'Log', 'Symlog']);
    select.value = axis === 'color' ? 'sqrt' : 'symlog';
    select.dispatchEvent(new Event('change'));
    expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith(expect.objectContaining({ t: 'patchPanel', patch: {
      options: expect.objectContaining({ [axis === 'color' ? 'colorScale' : `${axis}Scale`]: select.value }),
    } }));
    expect(overlay.querySelector('[aria-label="' + (axis === 'color' ? 'Domain' : 'Range') + '"]')).not.toBeNull();
  });

  it.each(['F10', 'ContextMenu'])('opens chart actions with %s and exposes all actions', async key => {
    const fixture = create(makePanel());
    const body = fixture.nativeElement.querySelector('[aria-label="Chart body"]') as HTMLElement;
    body.focus(); body.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    const actions = Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(actions.map(button => button.textContent?.trim())).toEqual(['Zoom to brush', 'Reset axes', 'Maximize', "Export this card's rows", 'Copy link to this card']);
    expect(actions[0].disabled).toBe(true);
    actions[1].focus(); actions[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(actions[2]);
    actions[3].click();
    expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith({ t: 'openExport', panelId: 'panel-1' });
  });

  it.each([
    ['Reset axes', { t: 'resetPanelRanges', id: 'panel-1' }],
    ['Maximize', { t: 'maximizePanel', id: 'panel-1' }],
    ['Zoom to brush', { t: 'zoomToBrush', from: 'panel-1' }],
  ])('dispatches chart action %s', async (label, command) => {
    const fixture = create(makePanel());
    const graph = TestBed.inject(Graph);
    (graph.state$ as BehaviorSubject<State>).next({ ...makeState(makePanel()), selections: [{ from: 'panel-1', metric: asColumnId('snr'), range: [1, 2] }] });
    fixture.nativeElement.querySelector('[aria-label="Chart body"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    const button = Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.trim() === label)!;
    button.click(); expect(graph.dispatch).toHaveBeenCalledWith(command);
  });

  it('copies a link that opens this card in panel view', async () => {
    const fixture = create(makePanel());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await fixture.componentInstance.copyCardLink();
    const link = new URL(writeText.mock.calls[0][0]);
    expect(link.searchParams.get('view')).toBe('panel');
    expect(link.searchParams.get('panel')).toBe('panel-1');
    expect(decodeUrlState(link.searchParams.get('s'))?.maximizedPanel).toBe('panel-1');
  });

  it.each([
    ['histogram', ['Clip', 'Follow brushed range']],
    ['heatmap', ['Clip', 'Follow brushed range']],
    ['band', ['Quantiles', 'Clip', 'Follow brushed range']],
  ] as const)('keeps only the applicable options in a single nontruncating column: %s', async (form, labels) => {
    const fixture = create(makePanel({ form, y: form === 'histogram' ? null : asColumnId('fd_mean') }));
    fixture.nativeElement.querySelector('[aria-label="Panel options"]').click();
    fixture.detectChanges(); await fixture.whenStable();
    const menu = TestBed.inject(OverlayContainer).getContainerElement().querySelector('[data-testid="panel-settings"]')!;
    const rows = Array.from(menu.querySelectorAll('.setting-row'));
    expect(rows.map(row => row.querySelector('span')?.textContent?.trim())).toEqual(labels);
    expect(rows.every(row => row.hasAttribute('appSettingRow') && !!row.querySelector('input,select'))).toBe(true);
    expect(menu.querySelector('.truncate, .grid-cols-2')).toBeNull();
    const cells = menu.querySelector<HTMLSelectElement>('[aria-label="Cells"]');
    if (cells) {
      expect(cells.value).toBe('60');
      expect(Array.from(cells.options, option => option.value)).toEqual(['30', '60', '120']);
      cells.value = '120'; cells.dispatchEvent(new Event('change'));
      expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith(expect.objectContaining({ patch: { options: expect.objectContaining({ cells: 120 }) } }));
    }
  });
  it.each(['band', 'lines', 'histogram'] as const)('offers Quantiles only for Band/Lines: %s', async form => {
    const fixture = create(makePanel({ form, y: form === 'histogram' ? null : asColumnId('fd_mean') }));
    fixture.nativeElement.querySelector('[aria-label="Panel options"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    const select = TestBed.inject(OverlayContainer).getContainerElement().querySelector<HTMLSelectElement>('[aria-label="Quantiles"]');
    if (form === 'histogram') { expect(select).toBeNull(); return; }
    expect(Array.from(select!.options, option => option.text)).toEqual(['Quartiles', 'Tails']);
    expect(select!.value).toBe('quartiles');
    select!.value = 'tails';
    select!.dispatchEvent(new Event('change'));
    expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith(expect.objectContaining({ t: 'patchPanel', patch: { options: expect.objectContaining({ quantiles: 'tails' }) } }));
  });

  it.each([
    [makePanel(), ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table', 'Heatmap', 'Scatter', 'Clusters', 'Band', 'Lines']],
    [
      makePanel({ x: 'created_at', form: 'line' }),
      ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table', 'Heatmap', 'Scatter', 'Clusters', 'Band', 'Lines'],
    ],
    [
      makePanel({ x: asColumnId('manufacturer'), form: 'bars' }),
      ['Bars', 'Share'],
    ],
    [
      makePanel({ y: asColumnId('efc'), form: 'heatmap' }),
      ['Heatmap', 'Scatter', 'Clusters', 'Band', 'Lines'],
    ],
    [
      makePanel({ form: 'matrix' }),
      ['Matrix'],
    ],
    [
      makePanel({ x: 'created_at', y: asColumnId('fd_mean'), form: 'band' }),
      ['Heatmap', 'Scatter', 'Clusters', 'Band', 'Lines'],
    ],
  ])('shows the fixed-order visible %s form options', (panel, expectedLabels) => {
    const optionLabels = formOptionLabels(panel);

    expect(optionLabels).toHaveLength(expectedLabels.length);
    expect(optionLabels.every((label, index) => label.startsWith(expectedLabels[index]))).toBe(
      true,
    );
    const options = Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll('mat-option'));
    const singleContinuous = panel.y === null && (panel.x === 'snr' || panel.x === 'created_at') && panel.form !== 'matrix';
    options.forEach((option, index) => {
      // Band (index 10) stays enabled for counts over time.
      const disabled = singleContinuous && index >= 7 && !(panel.x === 'created_at' && index === 10);
      expect(option.getAttribute('aria-disabled')).toBe(String(disabled));
      expect(option.querySelector('.form-option-hint')?.textContent?.trim() === 'add a second column').toBe(disabled);
      if (disabled) expect(option.getAttribute('aria-label')).toContain('add a second column');
    });
  });

  it('dispatches an enabled form but ignores disabled forms', () => {
    const fixture = create(makePanel());
    fixture.nativeElement.querySelector('[aria-label="Form"] .mat-mdc-select-trigger').click();
    fixture.detectChanges();
    const options = TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLElement>('mat-option');
    const dispatch = TestBed.inject(Graph).dispatch;
    options[7].click();
    fixture.detectChanges();
    expect(dispatch).not.toHaveBeenCalled();
    fixture.componentInstance.changeForm('heatmap');
    expect(dispatch).not.toHaveBeenCalled();
    options[3].click();
    fixture.detectChanges();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'setPanelForm', id: 'panel-1', form: 'density' });
  });

  it.each([asColumnId('snr'), 'created_at' as const])('opens and focuses the Y filter slot from a disabled reason for %s', async x => {
    const fixture = create(makePanel({ x }));
    fixture.nativeElement.querySelector('[aria-label="Form"] .mat-mdc-select-trigger').click();
    fixture.detectChanges();
    await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const link = overlay.querySelector<HTMLAnchorElement>('.form-reason')!;
    expect(link.getAttribute('aria-disabled')).toBe('false');
    link.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[aria-label="Form"]').getAttribute('aria-expanded')).toBe('false');
    expect(overlay.querySelector('.column-drawer [aria-label="Y slot (optional)"]')).not.toBeNull();
    // jsdom has no layout for CDK's visibility check; the live check verifies focus.
    expect(overlay.querySelector('.column-drawer [aria-label="Y slot (optional)"]')?.hasAttribute('cdkFocusInitial')).toBe(true);
    expect(TestBed.inject(Graph).dispatch).not.toHaveBeenCalled();
    const slot = overlay.querySelector<HTMLInputElement>('.column-drawer [aria-label="Y slot (optional)"]')!;
    slot.value = 'tsnr';
    slot.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    overlay.querySelector<HTMLButtonElement>('[data-column-id="tsnr"]')!.click();
    expect(TestBed.inject(Graph).dispatch).toHaveBeenCalledWith({ t: 'patchPanel', id: 'panel-1', patch: { x, y: 'tsnr', form: 'heatmap' } });
  });

  it('lets keyboard users activate the disabled reason without selecting a form', async () => {
    const fixture = create(makePanel());
    const select = fixture.nativeElement.querySelector('[aria-label="Form"]') as HTMLElement;
    select.querySelector<HTMLElement>('.mat-mdc-select-trigger')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
    const link = TestBed.inject(OverlayContainer).getContainerElement().querySelector<HTMLAnchorElement>('.form-reason')!;
    expect(document.activeElement).toBe(link);
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.columnPickerOpen()).toBe(true);
    expect(TestBed.inject(Graph).dispatch).not.toHaveBeenCalled();
  });

  it('opens the title drawer preselected and restores title focus on Escape', async () => {
    const fixture = create(makePanel());
    const title = fixture.nativeElement.querySelector('[data-testid="metric-title"]') as HTMLButtonElement;
    title.focus();
    title.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const drawer = overlay.querySelector('.column-drawer')!;
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.querySelector('[data-column-id="snr"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(drawer.querySelector('[aria-label="Y slot (optional)"]')).not.toBeNull();
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(overlay.querySelector('.column-drawer')).toBeNull();
    expect(document.activeElement).toBe(title);
  });

  it('isolates a legend series and resets it on double click', () => {
    const fixture = create(makePanel({ series: [{ kind: 'population' }] }));
    const legend = fixture.nativeElement.querySelector(
      '[data-testid="panel-legend"]',
    ) as HTMLElement;
    const firstChip = legend.querySelector('button[aria-pressed]') as HTMLButtonElement;

    firstChip.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.isolatedId()).toBe('current');
    expect(firstChip.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.stringify(fixture.componentInstance.vegaInput()?.spec)).toContain('datum.seriesId ===');
    expect(JSON.stringify(fixture.componentInstance.vegaInput()?.spec)).toContain('0.18');

    firstChip.dispatchEvent(new MouseEvent('dblclick'));
    fixture.detectChanges();
    expect(fixture.componentInstance.isolatedId()).toBeNull();
    expect(firstChip.getAttribute('aria-pressed')).toBe('false');
    expect(fixture.componentInstance.vegaInput()?.spec).toEqual(panelView.spec);
  });
});
