// @vitest-environment jsdom
import { parse, scale, View } from 'vega';
import { compile } from 'vega-lite';
import { describe, expect, it } from 'vitest';
import { attachAxisBandGestures, invertAxisRange } from './axis-band-gestures';

describe('invertAxisRange', () => {
  it('opens menus from both real axis bands and the compiled color legend', async () => {
    const compiled = compile({ width: 300, height: 200,
      data: { values: [{ x: 1, y: 2, n: 3 }, { x: 2, y: 3, n: 8 }] }, mark: 'point',
      encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' },
        color: { field: 'n', type: 'quantitative', scale: { type: 'log' }, legend: { type: 'gradient' } } },
    } as never).spec;
    const view = new View(parse(compiled), { renderer: 'none' }); await view.runAsync();
    const host = document.createElement('div'); document.body.append(host);
    const events: string[] = [];
    host.addEventListener('elementcontext', event => events.push((event as CustomEvent<{axis: string}>).detail.axis));
    const controller = attachAxisBandGestures(host, view, () => undefined);
    try {
      for (const [selector, axis] of [['.vega-axis-band-x', 'x'], ['.vega-axis-band-y', 'y'], ['.vega-color-legend-band', 'color']]) {
        const band = host.querySelector<HTMLElement>(selector);
        expect(band, selector).not.toBeNull();
        expect(band!.tabIndex).toBe(0);
        band!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        band!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
        band!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
        band!.querySelector('button')!.click();
        expect(events.slice(-4)).toEqual([axis, axis, axis, axis]);
      }
    } finally { controller.destroy(); view.finalize(); host.remove(); }
  });
  it('uses a linear Vega scale to convert horizontal pixels', () => {
    const linear = scale('linear')().domain([0, 100]).range([20, 220]);

    expect(invertAxisRange(linear, 60, 180)).toEqual([20, 80]);
  });

  it('uses a logarithmic Vega scale instead of linear interpolation', () => {
    const logarithmic = scale('log')().domain([1, 1_000]).range([0, 300]);

    const range = invertAxisRange(logarithmic, 100, 200);

    expect(range?.[0]).toBeCloseTo(10);
    expect(range?.[1]).toBeCloseTo(100);
  });

  it('normalizes Date values from a temporal Vega scale to timestamps', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const end = new Date('2024-01-05T00:00:00.000Z');
    const time = scale('time')().domain([start, end]).range([0, 400]);

    expect(invertAxisRange(time, 100, 300)).toEqual([
      Date.parse('2024-01-02T00:00:00.000Z'),
      Date.parse('2024-01-04T00:00:00.000Z'),
    ]);
  });

  it('places a compiled Vega x-axis band in host coordinates including canvas, origin, and padding', async () => {
    const compiled = compile({
      data: { values: [{ value: 1 }, { value: 2 }] },
      mark: 'point',
      encoding: { x: { field: 'value', type: 'quantitative' }, y: { field: 'value', type: 'quantitative' } },
    } as never).spec;
    const view = new View(parse(compiled), { renderer: 'none' });
    await view.runAsync();
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    const rect = (left: number, top: number): DOMRect => ({ left, top } as DOMRect);
    Object.defineProperty(host, 'getBoundingClientRect', { value: () => rect(10, 20) });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => rect(30, 40) });
    host.append(canvas);

    const controller = attachAxisBandGestures(host, {
      origin: view.origin.bind(view),
      padding: view.padding.bind(view),
      scale: view.scale.bind(view),
      width: view.width.bind(view),
      height: view.height.bind(view),
    }, () => undefined);
    const xBand = host.querySelector<HTMLElement>('.vega-axis-band-x');
    const xScale = view.scale('x') as { range(): number[] };
    const padding = view.padding() as { left: number };
    const expected = 20 + view.origin()[0] + padding.left + Math.min(...xScale.range());

    expect(Number.parseFloat(xBand?.style.left ?? '')).toBeCloseTo(expected);
    controller.destroy();
  });

  it('uses the full plot dimension for a categorical opposite axis', () => {
    const host = document.createElement('div');
    const linear = Object.assign((value: number) => value, {
      invert: (value: number) => value,
      range: () => [0, 400],
    });
    const categorical = Object.assign((value: string) => value, { range: () => [25, 75, 125] });
    const controller = attachAxisBandGestures(host, {
      scale: (name: string) => {
        if (name === 'x') return linear;
        if (name === 'y') return categorical;
        throw new Error('missing scale');
      },
      width: () => 400,
      height: () => 200,
    }, () => undefined);
    const xBand = host.querySelector<HTMLElement>('.vega-axis-band-x');

    expect(xBand?.style.top).toBe('200px');
    controller.destroy();
  });
});
