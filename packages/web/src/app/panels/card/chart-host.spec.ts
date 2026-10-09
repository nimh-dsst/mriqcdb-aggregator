import { TestBed } from '@angular/core/testing';
import { asColumnId } from '@mriqc/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartHost } from './chart-host';
import { VEGA_EMBED } from '../vega-view.directive';
import { makePanel, panelView } from './card-test-harness';

afterEach(() => vi.unstubAllGlobals());

describe('ChartHost', () => {
  it('routes live Vega brush and cell events and keeps resize local', async () => {
    const signals = new Map<string, (name: string, value: unknown) => void>();
    let click: (event: unknown, item: { datum: Record<string, unknown> }) => void = () => {};
    const resizeObservers: (() => void)[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeObservers.push(callback); }
      observe() {}
      disconnect = disconnect;
    });
    const vega = {
      finalize: vi.fn(), data: vi.fn(), width: vi.fn(), height: vi.fn(), resize: vi.fn(),
      runAsync: vi.fn(async () => {}),
      addSignalListener(name: string, callback: (name: string, value: unknown) => void) { signals.set(name, callback); },
      addEventListener(_name: string, callback: typeof click) { click = callback; },
    };
    const embed = vi.fn(async () => ({ view: vega, finalize: vega.finalize }));
    TestBed.configureTestingModule({ providers: [{ provide: VEGA_EMBED, useValue: async () => embed }] });
    const fixture = TestBed.createComponent(ChartHost);
    fixture.componentRef.setInput('view', {
      ...panelView, panel: makePanel({ y: asColumnId('efc') }), status: { kind: 'ready', stale: false },
      live: true, spec: { ...panelView.spec, width: 'container', height: 'container' }, datasets: { series: [{ x: 1 }] },
    });
    const command = vi.spyOn(fixture.componentInstance.command, 'emit');
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    fixture.detectChanges(); await fixture.whenStable();
    await vi.waitFor(() => expect(vega.resize).toHaveBeenCalled());
    expect(embed).toHaveBeenCalledOnce();
    resizeObservers.forEach(resized => resized());
    await vi.waitFor(() => expect(vega.resize).toHaveBeenCalledTimes(2));
    expect(command).not.toHaveBeenCalled();
    signals.get('brush')!('brush', { x: [1, 2] });
    signals.get('brush2d')!('brush2d', { x: [1, 2], y: [3, 4] });
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command).toHaveBeenCalledWith({ t: 'brush', from: 'panel-1', metric: 'snr', range: [1, 2] });
    expect(command).toHaveBeenCalledWith({ t: 'brush2d', from: 'panel-1', x: 'snr', y: 'efc', ranges: { x: [1, 2], y: [3, 4] } });
    click({}, { datum: { xMetric: 'snr', yMetric: 'efc' } });
    expect(patch).toHaveBeenCalledExactlyOnceWith({ x: 'snr', y: 'efc', form: 'heatmap' });
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledTimes(resizeObservers.length);
    expect(vega.finalize).toHaveBeenCalledOnce();
  });

  it('shows the server error verbatim and emits the selected retry key', () => {
    const fixture = TestBed.createComponent(ChartHost);
    fixture.componentRef.setInput('view', { ...panelView, panel: makePanel(), status: { kind: 'error', message: 'Data unavailable', retryKeys: ['distribution/key'] } });
    const retry = vi.spyOn(fixture.componentInstance.retry, 'emit');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="panel-error-message"]').textContent).toBe('Data unavailable');
    fixture.nativeElement.querySelector('[data-testid="panel-retry"]').click();
    expect(retry).toHaveBeenCalledExactlyOnceWith('distribution/key');
  });
});
