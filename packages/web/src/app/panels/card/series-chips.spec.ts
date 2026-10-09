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
import { initialState } from '../../loop/reducer';
import { defaultPanelOptions, type Panel, type State } from '../../graph/state';
import { PanelCard } from '../panel-card';
import { decodeUrlState } from '../../url/url';
import { panelCohorts } from '../../slices/series/queries';

import { makePanel, panelView, makeState, create, formOptionLabels } from './card-test-harness';

describe('series-chips', () => {
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
