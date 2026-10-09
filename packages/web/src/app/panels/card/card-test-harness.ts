import type { PanelView } from '../../slices/panels/view';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideZonelessChangeDetection } from '@angular/core';
import { asColumnId } from '@mriqc/shared';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WEB_ICONS } from '../../app.config';
import { Theme } from '../../chrome/theme';
import { Graph } from '../../loop/graph';
import { initialState } from '../../slices/reducer';
import { defaultPanelOptions, type Panel, type State } from '../../graph/state';
import { PanelCardShell as PanelCard } from '../panel-card';
import { decodeUrlState } from '../../url/url';
import { panelCohorts } from '../../slices/series/queries';

import { By } from '@angular/platform-browser';
import { CardHeader } from './card-header';
import { ChartHost } from './chart-host';
import { cardControls } from './card-projection';
export const makePanel = (overrides: Partial<Panel> = {}): Panel => ({
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

export const panelView = {
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

export const makeState = (panel: Panel): State => ({
  ...initialState,
  panels: [panel],
  global: { ...initialState.global, modality: 'bold', view: 'raw', filters: [] },
  catalog: null,
  cohorts: [],
  study: 'none',
});

export const create = (panel: Panel) => {
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
  const subscription = graph.state$.subscribe(state => {
    fixture.componentRef.setInput('view', { ...panelView, panel, controls: cardControls(state, panel) });
  });
  fixture.componentRef.onDestroy(() => subscription.unsubscribe());
  fixture.detectChanges();
  const originalInstance = fixture.componentInstance;
  const componentInstance = Object.assign(originalInstance, {
    columnPickerOpen: () => fixture.debugElement.query(By.directive(CardHeader)).componentInstance.columnPickerOpen(),
    vegaInput: () => fixture.debugElement.query(By.directive(ChartHost)).componentInstance.vegaInput(),
  });
  return Object.assign(fixture, { componentInstance });
};

export const formOptionLabels = (panel: Panel): readonly string[] => {
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
