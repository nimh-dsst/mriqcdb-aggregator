// @vitest-environment jsdom
import { parse, scale, View } from 'vega';
import { compile } from 'vega-lite';
import { describe, expect, it, vi } from 'vitest';
import { attachAxisBandGestures, invertAxisRange, zoomAxisRange } from './axis-band-gestures';

describe('axis wheel zoom', () => {
  it('shrinks or extends a linear domain 10% around an off-centre pointer', () => {
    const linear = scale('linear')().domain([0, 100]).range([0, 200]);
    expect(zoomAxisRange(linear, [0, 200], 50, -120)).toEqual([2.5, 92.5]);
    expect(zoomAxisRange(linear, [0, 200], 50, 120)).toEqual([expect.closeTo(-2.5), expect.closeTo(107.5)]);
    expect(zoomAxisRange(linear, [0, 200], 50, 0)).toEqual([0, 100]);
  });

  it('zooms a logarithmic domain in log space', () => {
    const log = scale('log')().domain([1, 1000]).range([0, 300]).clamp(true);
    const zoomed = zoomAxisRange(log, [0, 300], 100, -100)!;
    expect(zoomed[0]).toBeCloseTo(10 ** 0.1);
    expect(zoomed[1]).toBeCloseTo(10 ** 2.8);
    const extended = zoomAxisRange(log, [0, 300], 100, 100)!;
    expect(extended[0]).toBeCloseTo(10 ** -0.1);
    expect(extended[1]).toBeCloseTo(10 ** 3.2);
    expect(log.clamp()).toBe(true);
    const dragged = invertAxisRange(log, -100, 400)!;
    expect(dragged[0]).toBeCloseTo(0.1);
    expect(dragged[1]).toBeCloseTo(10000);
  });

  it('zooms time and reversed vertical domains using native inversion', () => {
    const start = Date.UTC(2024, 0, 1), day = 86_400_000;
    const time = scale('time')().domain([new Date(start), new Date(start + 10 * day)]).range([0, 100]);
    expect(zoomAxisRange(time, [0, 100], 50, -3)).toEqual([start + day / 2, start + 9.5 * day]);
    const vertical = scale('linear')().domain([0, 100]).range([200, 0]);
    expect(zoomAxisRange(vertical, [0, 200], 50, -3)).toEqual([expect.closeTo(7.5), expect.closeTo(97.5)]);
  });

  it('keeps a symlog zoom spanning zero finite', () => {
    const symlog = scale('symlog')().domain([-100, 100]).range([0, 200]);
    const range = zoomAxisRange(symlog, [0, 200], 100, 1)!;
    expect(range[0]).toBeLessThan(-100);
    expect(range[1]).toBeGreaterThan(100);
    expect(range.every(Number.isFinite)).toBe(true);
  });

  function setup() {
    const host = document.createElement('div');
    document.body.append(host);
    const linear = scale('linear')().domain([0, 100]).range([0, 200]);
    const emit = vi.fn();
    const controller = attachAxisBandGestures(host, {
      scale: name => name === 'x' ? linear : undefined,
      width: () => 200, height: () => 100,
    }, emit);
    const band = host.querySelector<HTMLElement>('.vega-axis-band-x')!;
    const wheel = (deltaY: number, clientX = 100) => {
      const event = new WheelEvent('wheel', { deltaY, clientX, bubbles: true, cancelable: true });
      band.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    return { host, emit, controller, band, wheel, linear };
  }

  it('commits one range after 500ms idle and compounds repeated notches', () => {
    vi.useFakeTimers();
    const { host, emit, controller, wheel } = setup();
    try {
      wheel(-100);
      vi.advanceTimersByTime(400);
      wheel(-100);
      controller.refresh();
      vi.advanceTimersByTime(499);
      expect(emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(emit).toHaveBeenCalledExactlyOnceWith({ axis: 'x', range: [9.5, 90.5] });
    } finally { controller.destroy(); host.remove(); vi.useRealTimers(); }
  });

  it('cancels a pending zoom on double-click or teardown', () => {
    vi.useFakeTimers();
    const { host, emit, controller, band, wheel } = setup();
    try {
      wheel(100);
      band.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      vi.advanceTimersByTime(500);
      expect(emit).toHaveBeenCalledExactlyOnceWith({ axis: 'x', range: 'auto' });
      wheel(-100);
      controller.destroy();
      vi.advanceTimersByTime(500);
      expect(emit).toHaveBeenCalledTimes(1);
    } finally { controller.destroy(); host.remove(); vi.useRealTimers(); }
  });

  it('retains the scale at burst start if live Vega data changes before idle', () => {
    vi.useFakeTimers();
    const { host, emit, controller, wheel, linear } = setup();
    try {
      wheel(-100);
      linear.domain([0, 1000]);
      controller.refresh();
      vi.advanceTimersByTime(500);
      expect(emit).toHaveBeenCalledExactlyOnceWith({ axis: 'x', range: [5, 95] });
    } finally { controller.destroy(); host.remove(); vi.useRealTimers(); }
  });

  it.each([-100, 300])('extends a captured drag beyond the axis to pixel %s', end => {
    const { host, emit, controller, band } = setup();
    band.setPointerCapture = vi.fn();
    band.hasPointerCapture = () => true;
    band.releasePointerCapture = vi.fn();
    try {
      const pointer = (type: string, clientX: number) => band.dispatchEvent(Object.assign(
        new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true }), { pointerId: 1 }));
      pointer('pointerdown', 100);
      pointer('pointermove', end);
      pointer('pointerup', end);
      expect(emit).toHaveBeenCalledExactlyOnceWith({ axis: 'x', range: end < 0 ? [-50, 50] : [50, 150] });
    } finally { controller.destroy(); host.remove(); }
  });
});

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
