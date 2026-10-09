import { range2dOf } from './vega-view.directive';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { VEGA_EMBED, VegaViewDirective, type VegaInput } from './vega-view.directive';

@Component({ imports: [VegaViewDirective], template: '<div [appVegaView]="input" (brush2d)="events.push($event)"></div>' })
class RendererHost {
  events: unknown[] = [];
  input: VegaInput = { specKey: 'density', spec: { mark: 'point', data: { name: 'rows' } }, live: true, datasets: { rows: [{ x: 1, y: 2 }] } };
}

describe('range2dOf', () => {
  it('parses both interval axes', () => {
    expect(range2dOf({ x: [1, 3], y: [2, 4] })).toEqual({
      x: [1, 3],
      y: [2, 4],
    });
  });

  it('returns null for a cleared or malformed brush signal', () => {
    expect(range2dOf(null)).toBeNull();
    expect(range2dOf({ x: [1, 3] })).toBeNull();
    expect(range2dOf({ x: [1], y: [2, 4] })).toBeNull();
  });
});

it.each(['pointerup', 'blur'])('flushes the final debounced brush on %s', async event => {
  const listeners = new Map<string, (name: string, value: unknown) => void>();
  const view = { finalize() {}, data() {}, addSignalListener(name: string, callback: (name: string, value: unknown) => void) { listeners.set(name, callback); }, async runAsync() {} };
  TestBed.configureTestingModule({ imports: [RendererHost], providers: [{ provide: VEGA_EMBED, useValue: async () => async () => ({ view, finalize() {} }) }] });
  const fixture = TestBed.createComponent(RendererHost);
  fixture.detectChanges(); await fixture.whenStable();
  await vi.waitFor(() => expect(listeners.has('brush2d')).toBe(true));
  fixture.nativeElement.querySelector('div').dispatchEvent(new Event('pointerdown'));
  listeners.get('brush2d')?.('brush2d', { x: [1, 2], y: [3, 4] });
  expect(fixture.componentInstance.events).toEqual([]);
  window.dispatchEvent(new Event(event));
  expect(fixture.componentInstance.events).toEqual([{ x: [1, 2], y: [3, 4] }]);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(fixture.componentInstance.events).toHaveLength(1);
  fixture.destroy();
});

it('does not turn programmatic dataset refresh signals into linked brush commands', async () => {
  const listeners = new Map<string, (name: string, value: unknown) => void>();
  const view = { finalize() {}, data() {}, addSignalListener(name: string, callback: (name: string, value: unknown) => void) { listeners.set(name, callback); },
    async runAsync() { listeners.get('brush2d')?.('brush2d', { x: [8, 9], y: [10, 11] }); } };
  TestBed.configureTestingModule({ imports: [RendererHost], providers: [{ provide: VEGA_EMBED, useValue: async () => async () => ({ view, finalize() {} }) }] });
  const fixture = TestBed.createComponent(RendererHost);
  fixture.detectChanges(); await fixture.whenStable();
  await vi.waitFor(() => expect(listeners.has('brush2d')).toBe(true));
  listeners.get('brush2d')?.('brush2d', { x: [1, 2], y: [3, 4] });
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(fixture.componentInstance.events).toEqual([{ x: [1, 2], y: [3, 4] }]);
  fixture.componentInstance.input = { ...fixture.componentInstance.input, datasets: { rows: [{ x: 4, y: 5 }] } };
  fixture.detectChanges(); await fixture.whenStable();
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(fixture.componentInstance.events).toHaveLength(1);
  fixture.destroy();
});
