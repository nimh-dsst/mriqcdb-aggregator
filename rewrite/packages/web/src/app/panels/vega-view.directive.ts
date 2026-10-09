/**
 * The renderer edge: one Vega view per panel, spec and data in, brushes out.
 *
 * It takes the `{ specKey, spec, datasets }` tuple a projection produced, so a
 * chart can never show a spec from one state with data from another. It diffs:
 * the spec changed, re-embed; only the datasets changed, push them into the
 * live view by name. That is why every spec references `data: { name }`.
 */

import {
  DestroyRef,
  Directive,
  ElementRef,
  InjectionToken,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { outputFromObservable } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import type { TopLevelSpec } from 'vega-lite';
import {
  attachAxisBandGestures,
  type AxisBandGestures,
  type AxisRangeEvent,
  type VegaAxisBandView,
} from './axis-band-gestures';

/** What the directive needs from a panel view. */
export interface VegaInput {
  /** Changes exactly when the spec's shape changes, never when its data does. */
  specKey: string;
  spec: TopLevelSpec | null;
  /** False while a result is in flight; the directive then leaves the view alone. */
  live: boolean;
  datasets: Readonly<Record<string, readonly unknown[]>>;
}

/** An interval brush, or null when the user cleared it. */
export type BrushRange = [number, number] | null;

export type Brush2dRange = {
  x: [number, number];
  y: [number, number];
} | null;

export function range2dOf(value: unknown): Brush2dRange {
  if (value === null || typeof value !== 'object') {
    return null;
  }

  const { x, y } = value as { x?: unknown; y?: unknown };
  const xRange = rangeOf({ x });
  const yRange = rangeOf({ y });

  return xRange !== null && yRange !== null ? { x: xRange, y: yRange } : null;
}

function sameRange2d(a: Brush2dRange, b: Brush2dRange): boolean {
  if (a === b) {
    return true;
  }

  return a !== null && b !== null && sameRange(a.x, b.x) && sameRange(a.y, b.y);
}

type EmbedFn = typeof import('vega-embed')['default'];

/**
 * How the directive gets vega-embed. Dynamic by default, which keeps ~700 kB of
 * Vega out of the initial bundle; overridable so a component test can render a
 * dashboard without a canvas.
 */
export const VEGA_EMBED = new InjectionToken<() => Promise<EmbedFn>>('mriqc.vegaEmbed', {
  providedIn: 'root',
  factory: () => async () => (await import('vega-embed')).default,
});

/**
 * Vega-Lite gives facet cells a fixed size. Small multiples that declare
 * `usermeta.facets` get their cell size from the container instead, through
 * the compiled `child_width` / `child_height` signals, leaving room for the
 * y axis, the colour legend, the headers and the x axis.
 */
function fitFacets(view: EmbeddedView, spec: unknown, container: HTMLElement): void {
  const meta = (spec as { usermeta?: { facets?: unknown }; columns?: unknown } | null);
  const facets = Number(meta?.usermeta?.facets), columns = Number(meta?.columns);
  if (!view.signal || !(facets > 0) || !(columns > 0)) return;
  const rows = Math.ceil(facets / columns), gap = 20;
  // The host shrinks to the canvas it holds; the slot around it is the room there is.
  const slot = container.parentElement ?? container;
  const width = (slot.clientWidth - 60 - 110 - gap * (columns - 1)) / columns;
  const height = (slot.clientHeight - 50 - rows * 20 - gap * (rows - 1)) / rows;
  try {
    view.signal('child_width', Math.max(120, Math.floor(width)));
    view.signal('child_height', Math.max(90, Math.floor(height)));
  } catch {
    // Not a faceted view after all.
  }
}

interface EmbeddedView {
  addEventListener?(name: string, handler: (event: unknown, item: { datum?: Record<string, unknown> } | null) => void): unknown;
  finalize(): void;
  data(name: string, values: unknown): unknown;
  runAsync(): Promise<unknown>;
  resize?(): unknown;
  width?(value: number): unknown;
  height?(value: number): unknown;
  signal?(name: string, value: number): unknown;
  addSignalListener(name: string, handler: (name: string, value: unknown) => void): unknown;
}

function rangeOf(value: unknown): BrushRange {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.values(value as Record<string, unknown>);
  const first = entries[0];
  if (!Array.isArray(first) || first.length !== 2) return null;
  const [lo, hi] = first as [unknown, unknown];
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo, hi];
}

/** True when at least one named dataset has something to draw. */
function hasRows(datasets: Readonly<Record<string, readonly unknown[]>>): boolean {
  return Object.values(datasets).some((rows) => rows.length > 0);
}

function sameRange(a: BrushRange, b: BrushRange): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

@Directive({ selector: '[appVegaView]' })
export class VegaViewDirective {
  readonly cell = output<{ x: string; y: string }>();
  readonly axisRange = output<AxisRangeEvent>();
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly embed = inject(VEGA_EMBED);

  /** The tuple to render. Null renders nothing and tears down any live view. */
  readonly appVegaView = input<VegaInput | null>(null);

  private readonly brushes = new Subject<BrushRange>();
  private readonly brushes2d = new Subject<Brush2dRange>();

  /**
   * Interval selections, debounced so one drag becomes one command rather than
   * fifty (`dashboard-graph.md`, "Brushing").
   */
  readonly brush = outputFromObservable(
    this.brushes.pipe(debounceTime(100), distinctUntilChanged(sameRange)),
  );

  readonly brush2d = outputFromObservable(
    this.brushes2d.pipe(debounceTime(100), distinctUntilChanged(sameRange2d)),
  );

  /** Edge bookkeeping for the press-and-hold case; see `onBrushSignal`. */
  private pointerDown = false;
  private pendingClear = false;
  private updating = 0;
  private pendingClear2d = false;

  private view: EmbeddedView | null = null;
  private axisBands: AxisBandGestures | null = null;
  private clearAxisBands = (): void => {
    this.axisBands?.destroy();
    this.axisBands = null;
  };
  private renderedSpecKey: string | null = null;
  private renderedDatasets: Readonly<Record<string, readonly unknown[]>> | null = null;
  /** Guards against an embed that resolves after a newer one started. */
  private generation = 0;
  private destroyed = false;
  private resizeFrame: number | null = null;

  constructor() {
    const host = this.host.nativeElement;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resizeChart());
    observer?.observe(host);
    const down = () => {
      this.pointerDown = true;
    };
    // `pointerup` on the window, not the host: a drag that ends outside the
    // chart still ends the gesture.
    const up = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      if (this.pendingClear) {
        this.pendingClear = false;
        this.brushes.next(null);
      }
      if (this.pendingClear2d) {
        this.pendingClear2d = false;
        this.brushes2d.next(null);
      }
    };
    host.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      observer?.disconnect();
      if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
      host.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.teardown();
    });
    effect(() => {
      const next = this.appVegaView();
      void this.render(next);
    });
  }

  /**
   * One signal value from Vega, on its way to becoming a `brush` command.
   *
   * Vega-Lite's interval handler sets the signal to equal bounds on
   * pointerdown, which resolves to null. A press held past the 100 ms debounce
   * would let that transient through as a clear, dropping the selection and
   * refetching every linked panel before the real drag range arrives and
   * refetches them again -- so a null while the pointer is down is deferred,
   * and only becomes a clear if the gesture ends without a range.
   */
  private onBrushSignal(value: unknown): void {
    if (this.updating) return;
    const range = rangeOf(value);
    if (range === null && this.pointerDown) {
      this.pendingClear = true;
      return;
    }
    this.pendingClear = false;
    this.brushes.next(range);
  }

  private onBrush2dSignal(value: unknown): void {
    if (this.updating) return;
    const range = range2dOf(value);
    if (range === null && this.pointerDown) {
      this.pendingClear2d = true;
      return;
    }
    this.pendingClear2d = false;
    this.brushes2d.next(range);
  }

  private async render(next: VegaInput | null): Promise<void> {
    if (!next || !next.spec) {
      this.teardown();
      return;
    }
    // Rendering an empty tuple would draw an axis over an empty domain, which
    // Vega logs as an infinite extent for every field. While a result is in
    // flight the panel keeps its last chart under a loading overlay, and a
    // genuinely empty result is covered by the panel's own empty state.
    if (!next.live || !hasRows(next.datasets)) return;
    if (this.view && this.renderedSpecKey === next.specKey) {
      if (this.renderedDatasets !== next.datasets) this.push(this.view, next.datasets);
      return;
    }
    const generation = ++this.generation;
    this.teardown();
    let embed: EmbedFn;
    try {
      embed = await this.embed();
    } catch {
      return;
    }
    if (this.destroyed || generation !== this.generation) return;
    try {
      // The rows go in as top-level `datasets` so the very first parse already
      // has a domain. Embedding a spec whose named data is empty makes Vega
      // compute an infinite extent for every field and log it.
      const seeded = { ...(next.spec as object), datasets: { ...next.datasets } };
      const result = await embed(this.host.nativeElement, seeded as never, {
        renderer: 'canvas',
        actions: false,
        config: {},
      });
      if (this.destroyed || generation !== this.generation) {
        result.finalize();
        return;
      }
      const view = result.view as unknown as EmbeddedView;
      this.view = view;
      this.clearAxisBands();
      this.axisBands = attachAxisBandGestures(
        this.host.nativeElement,
        view as unknown as VegaAxisBandView,
        (event) => this.axisRange.emit(event),
      );
      this.resizeChart();
      this.renderedSpecKey = next.specKey;
      this.renderedDatasets = next.datasets;
      view.addEventListener?.('click', (_event, item) => {
        const x = item?.datum?.['xMetric'], y = item?.datum?.['yMetric'];
        if (typeof x === 'string' && typeof y === 'string' && x !== y) this.cell.emit({ x, y });
      });
      try {
        view.addSignalListener('brush', (_name, value) => this.onBrushSignal(value));
      } catch {
        // The spec has no brush parameter; nothing to listen to.
      }
      try {
        view.addSignalListener('brush2d', (_name, value) => this.onBrush2dSignal(value));
      } catch {
        // The spec has no brush2d parameter; nothing to listen to.
      }
    } catch {
      // A spec Vega refuses to compile leaves the panel's error overlay to the
      // projection; there is nothing useful to do at the edge.
      this.view = null;
      this.renderedSpecKey = null;
    }
  }

  /** Chart-container measurements never enter dashboard geometry or state. */
  private resizeChart(): void {
    if (this.destroyed || this.resizeFrame !== null) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      const view = this.view;
      if (!view?.resize || this.destroyed) return;
      this.updating++;
      const container = this.host.nativeElement;
      const spec = this.appVegaView()?.spec as { width?: unknown; height?: unknown } | null;
      if (spec?.width === 'container') view.width?.(container.clientWidth);
      if (spec?.height === 'container') view.height?.(container.clientHeight);
      fitFacets(view, this.appVegaView()?.spec, container);
      view.resize();
      void view.runAsync().catch(() => undefined).finally(() => { this.axisBands?.refresh(); this.updating--; });
    });
  }

  private push(view: EmbeddedView, datasets: Readonly<Record<string, readonly unknown[]>>): void {
    this.updating++;
    this.renderedDatasets = datasets;
    let changed = false;
    for (const [name, values] of Object.entries(datasets)) {
      try {
        view.data(name, values as unknown[]);
        changed = true;
      } catch {
        // A dataset the compiled spec does not name. Skip it.
      }
    }
    if (changed) void view.runAsync().finally(() => { this.axisBands?.refresh(); this.updating--; });
    else this.updating--;
  }

  private teardown(): void {
    this.clearAxisBands();
    if (this.view) {
      try {
        this.view.finalize();
      } catch {
        // Already finalized.
      }
      this.view = null;
    }
    this.renderedSpecKey = null;
    this.renderedDatasets = null;
    this.host.nativeElement.replaceChildren();
  }
}
