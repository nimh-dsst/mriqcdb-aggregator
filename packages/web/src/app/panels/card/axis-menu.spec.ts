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
import { PanelCard } from '../panel-card';
import { decodeUrlState } from '../../url/url';
import { panelCohorts } from '../../slices/series/queries';

import { makePanel, panelView, makeState, create, formOptionLabels } from './card-test-harness';

describe('axis-menu', () => {
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

});
