import type { PanelView } from '../view/panel-view';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideZonelessChangeDetection } from '@angular/core';
import { asColumnId } from '@mriqc/shared';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { WEB_ICONS } from '../app.config';
import { Theme } from '../chrome/theme';
import { Graph } from '../graph/graph';
import { initialState } from '../graph/reducer';
import { defaultPanelOptions, type Panel, type State } from '../graph/state';
import { PanelCard } from './panel-card';

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
    dispatch: () => undefined,
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
  it.each([
    [makePanel(), ['Histogram', 'Density', 'ECDF', 'Box', 'Table']],
    [
      makePanel({ x: 'created_at', form: 'line' }),
      ['Bars', 'Line', 'Area'],
    ],
    [
      makePanel({ x: asColumnId('manufacturer'), form: 'bars' }),
      ['Bars', 'Share'],
    ],
    [
      makePanel({ y: asColumnId('efc'), form: 'heatmap' }),
      ['Heatmap', 'Scatter', 'Hexbin', 'Clusters'],
    ],
    [
      makePanel({ form: 'matrix' }),
      ['Matrix'],
    ],
    [
      makePanel({ x: 'created_at', y: asColumnId('fd_mean'), form: 'band' }),
      ['Band', 'Lines'],
    ],
  ])('shows the valid %s form options', (panel, expectedLabels) => {
    const optionLabels = formOptionLabels(panel);

    expect(optionLabels).toHaveLength(expectedLabels.length);
    expect(optionLabels.every((label, index) => label.startsWith(expectedLabels[index]))).toBe(
      true,
    );
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
    expect(drawer.querySelector('[aria-label="Second metric (y)"]')).not.toBeNull();
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(overlay.querySelector('.column-drawer')).toBeNull();
    expect(document.activeElement).toBe(title);
  });

  it('isolates a legend series and resets it on double click', () => {
    const fixture = create(makePanel({ series: [{ kind: 'population' }] }));
    const legend = fixture.nativeElement.querySelector(
      'app-compare-input',
    ) as HTMLElement;
    const firstChip = legend.querySelector('button') as HTMLButtonElement;

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
