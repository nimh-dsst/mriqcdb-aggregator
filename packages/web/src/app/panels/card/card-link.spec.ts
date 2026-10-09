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

describe('card-link', () => {
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

});
