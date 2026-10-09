import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { describe, expect, it, vi } from 'vitest';
import { WEB_ICONS } from '../app.config';
import { Graph } from '../graph/graph';
import { PanelCardShell } from './panel-card';
import { cardControls } from './card/card-projection';
import { makePanel, makeState, panelView } from './card/card-test-harness';

describe('PanelCard shell', () => {
  it.each(['histogram', 'time'] as const)('renders the slots for a %s panel', kind => {
    const panel = makePanel(kind === 'time' ? { x: 'created_at', form: 'line' } : {});
    // The shell gets a view and a dispatch edge; it has no state or projection stream.
    TestBed.configureTestingModule({ imports: [WEB_ICONS], providers: [
      { provide: Graph, useValue: { dispatch: vi.fn() } },
      { provide: MatDialog, useValue: { open: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(PanelCardShell);
    fixture.componentRef.setInput('view', { ...panelView, panel, controls: cardControls(makeState(panel), panel) });
    fixture.detectChanges();
    for (const slot of ['card-header', 'form-picker', 'bin-control', 'axis-menu', 'series-chips', 'stats-sheet', 'chart-host', 'card-footer']) {
      expect(fixture.nativeElement.querySelector(`app-${slot}`)).not.toBeNull();
    }
    expect(fixture.nativeElement.querySelector('[aria-label="' + (kind === 'time' ? 'Bin size' : 'Bins') + '"]')).not.toBeNull();
  });
});
