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

describe('card-options', () => {
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

});
