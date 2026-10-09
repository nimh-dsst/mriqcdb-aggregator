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
import { By } from '@angular/platform-browser';
import { MatrixControl } from './matrix-control';

describe('card-header', () => {
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

  it('preserves the matrix draft when the column drawer is reopened', async () => {
    const fixture = create(makePanel());
    const title = fixture.nativeElement.querySelector('[data-testid="metric-title"]') as HTMLButtonElement;
    title.click(); fixture.detectChanges(); await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const matrix = fixture.debugElement.queryAll(By.directive(MatrixControl)).find(element => element.componentInstance.drawer())!.componentInstance as MatrixControl;
    matrix.openMetricSet(); matrix.setCorrelationMetrics(['snr', 'efc']);
    fixture.detectChanges();
    overlay.querySelector('.column-drawer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    title.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(overlay.querySelector('[aria-label="Metric set"]')).not.toBeNull();
    const reopened = fixture.debugElement.queryAll(By.directive(MatrixControl)).find(element => element.componentInstance.drawer())!.componentInstance as MatrixControl;
    expect(reopened.correlationMetrics()).toEqual(['snr', 'efc']);
    expect(TestBed.inject(Graph).dispatch).not.toHaveBeenCalled();
  });
});
