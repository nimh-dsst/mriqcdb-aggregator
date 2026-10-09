import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { asColumnId } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';
import { Theme } from '../../chrome/theme';
import { Graph } from '../../loop/graph';
import type { State } from '../../graph/state';
import { CardProjection } from './card-projection';
import { makePanel, makeState } from './card-test-harness';

@Component({ imports: [CardProjection], template: '<app-panel-card [panelId]="id()" />' })
class ProjectionHost {
  readonly id = signal('panel-1');
  readonly projection = viewChild.required(CardProjection);
}

describe('CardProjection', () => {
  it('supplies chart and controls from one state snapshot and switches panel identity', async () => {
    const first = makePanel();
    const second = makePanel({ id: 'panel-2', x: 'created_at', form: 'line' });
    const state$ = new BehaviorSubject<State>({ ...makeState(first), panels: [first, second] });
    const dispatch = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: Graph, useValue: { state$, dispatch } },
      { provide: Theme, useValue: { mode: signal('light') } },
    ] });
    const fixture = TestBed.createComponent(ProjectionHost);
    fixture.detectChanges(); await fixture.whenStable();
    const projection = fixture.componentInstance.projection();
    expect(projection.view()?.panel).toBe(first);
    expect(projection.view()?.controls.hasBrush).toBe(false);
    state$.next({ ...state$.value, selections: [{ from: first.id, metric: asColumnId('snr'), range: [1, 2] }] });
    fixture.detectChanges();
    expect(projection.view()?.controls.hasBrush).toBe(true);
    expect(projection.view()?.controls.url.selections).toEqual(state$.value.selections);
    fixture.componentInstance.id.set(second.id);
    fixture.detectChanges(); await fixture.whenStable();
    expect(projection.view()?.panel).toBe(second);
    expect(projection.view()?.controls.hasBrush).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    fixture.destroy();
    expect(state$.observed).toBe(false);
  });
});
