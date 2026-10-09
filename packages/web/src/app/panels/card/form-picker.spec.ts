import type { PanelView } from '../../view/panel-view';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideZonelessChangeDetection } from '@angular/core';
import { asColumnId } from '@mriqc/shared';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WEB_ICONS } from '../../app.config';
import { Theme } from '../../chrome/theme';
import { Graph } from '../../graph/graph';
import { initialState } from '../../graph/reducer';
import { defaultPanelOptions, type Panel, type State } from '../../graph/state';
import { PanelCard } from '../panel-card';
import { decodeUrlState } from '../../graph/url';
import { panelCohorts } from '../../graph/queries';

import { makePanel, panelView, makeState, create, formOptionLabels } from './card-test-harness';

describe('form-picker', () => {
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

});
