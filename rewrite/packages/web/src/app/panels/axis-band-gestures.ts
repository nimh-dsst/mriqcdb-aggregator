export type AxisRangeEvent = { axis: 'x' | 'y'; range: [number, number] | 'auto' };
type Axis = AxisRangeEvent['axis'];
type Scale = ((value: unknown) => unknown) & { invert?: (value: number) => unknown; range?: () => unknown; copy?: () => Scale; clamp?: (value: boolean) => Scale };
type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
type Geometry = Bounds & { axis: Axis; scale: Scale; start: number; end: number; offset: number };
type Context = { offset: Point; scales: Record<string, unknown>; width: number | null; height: number | null };

export type VegaAxisBandView = {
  height?: () => number;
  origin?: () => unknown;
  padding?: () => unknown;
  scale?: (name: string) => unknown;
  scenegraph?: () => unknown;
  width?: () => number;
};
export type AxisBandGestures = { destroy(): void; refresh(): void };

const BAND_SIZE = 24;

function numeric(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
function property(value: Record<string, unknown>, key: string): number | null {
  return numeric(value[key]);
}
function asScale(value: unknown): Scale | null {
  const candidate = typeof value === 'function' ? value : record(value)?.['value'];
  return typeof candidate === 'function' ? (candidate as Scale) : null;
}
function range(scale: Scale | null): [number, number] | null {
  if (!scale || typeof scale.range !== 'function') return null;
  try {
    const values = scale.range();
    if (!Array.isArray(values) || values.length < 2) return null;
    const first = numeric(values[0]), last = numeric(values[values.length - 1]);
    return first === null || last === null ? null : [first, last];
  } catch { return null; }
}
function axisFor(name: string): Axis | null {
  return name === 'x' || name.endsWith('_x') ? 'x' : name === 'y' || name.endsWith('_y') ? 'y' : null;
}
function dimension(view: VegaAxisBandView, axis: Axis): number | null {
  const getter = axis === 'x' ? view.width : view.height;
  try { return typeof getter === 'function' ? numeric(getter.call(view)) : null; } catch { return null; }
}
function baseOffset(host: HTMLElement, view: VegaAxisBandView): Point {
  const hostRect = host.getBoundingClientRect();
  const surfaceRect = host.querySelector('canvas, svg')?.getBoundingClientRect();
  let origin: unknown, padding: Record<string, unknown> | null;
  try { origin = view.origin?.(); } catch { origin = undefined; }
  try { padding = record(view.padding?.()); } catch { padding = null; }
  return {
    x: (surfaceRect?.left ?? hostRect.left) - hostRect.left + (Array.isArray(origin) ? numeric(origin[0]) ?? 0 : 0) + (padding ? property(padding, 'left') ?? 0 : 0),
    y: (surfaceRect?.top ?? hostRect.top) - hostRect.top + (Array.isArray(origin) ? numeric(origin[1]) ?? 0 : 0) + (padding ? property(padding, 'top') ?? 0 : 0),
  };
}
function directContexts(view: VegaAxisBandView): Context[] {
  if (typeof view.scale !== 'function') return [];
  const scales: Record<string, unknown> = {};
  for (const name of ['x', 'y', 'child_x', 'child_y']) {
    try { scales[name] = view.scale(name); } catch { /* Vega throws for absent scales. */ }
  }
  return Object.keys(scales).length ? [{ offset: { x: 0, y: 0 }, scales, width: dimension(view, 'x'), height: dimension(view, 'y') }] : [];
}
function sceneContexts(view: VegaAxisBandView): Context[] {
  let root: unknown;
  try { root = record(view.scenegraph?.())?.['root']; } catch { return []; }
  if (!root) return [];
  const found: Context[] = [], seen = new WeakSet<object>();
  const visit = (node: unknown, parent: Point): void => {
    const item = record(node);
    if (!item || seen.has(item)) return;
    seen.add(item);
    const context = record(item['context']), scales = context && record(context['scales']);
    const offset = scales ? { x: parent.x + (property(item, 'x') ?? 0), y: parent.y + (property(item, 'y') ?? 0) } : parent;
    if (scales) found.push({ offset, scales, width: property(item, 'width'), height: property(item, 'height') });
    if (Array.isArray(item['items'])) for (const child of item['items']) visit(child, offset);
  };
  visit(root, { x: 0, y: 0 });
  return found;
}
function contextRange(context: Context, axis: Axis, view: VegaAxisBandView): [number, number] | null {
  for (const [name, candidate] of Object.entries(context.scales)) {
    const scale = asScale(candidate);
    const candidateRange = axisFor(name) === axis && typeof scale?.invert === 'function' ? range(scale) : null;
    if (candidateRange) return candidateRange;
  }
  const size = axis === 'x' ? context.width ?? dimension(view, axis) : context.height ?? dimension(view, axis);
  return size === null ? null : [0, size];
}
function geometry(context: Context, axis: Axis, scale: Scale, view: VegaAxisBandView, base: Point): Geometry | null {
  if (typeof scale.invert !== 'function') return null;
  const selected = range(scale), xRange = contextRange(context, 'x', view), yRange = contextRange(context, 'y', view);
  if (!selected || !xRange || !yRange) return null;
  const xOffset = base.x + context.offset.x, yOffset = base.y + context.offset.y;
  const x = [xRange[0] + xOffset, xRange[1] + xOffset], y = [yRange[0] + yOffset, yRange[1] + yOffset];
  const axisOffset = axis === 'x' ? xOffset : yOffset;
  const selectedPixels = [selected[0] + axisOffset, selected[1] + axisOffset];
  return { axis, scale, offset: axisOffset, start: Math.min(...selectedPixels), end: Math.max(...selectedPixels), left: Math.min(...x), right: Math.max(...x), top: Math.min(...y), bottom: Math.max(...y) };
}
function geometries(host: HTMLElement, view: VegaAxisBandView): Geometry[] {
  const found: Geometry[] = [], base = baseOffset(host, view);
  const scene = sceneContexts(view);
  for (const context of [...scene, ...directContexts(view)]) {
    for (const [name, value] of Object.entries(context.scales)) {
      const axis = axisFor(name), scale = asScale(value);
      if (!axis || !scale) continue;
      const candidate = geometry(context, axis, scale, view, base);
      if (!candidate) continue;
      const duplicate = found.some(existing =>
        existing.axis === candidate.axis &&
        Math.abs(existing.start - candidate.start) <= 1 &&
        Math.abs(existing.end - candidate.end) <= 1 &&
        Math.abs(existing.left - candidate.left) <= 1 &&
        Math.abs(existing.right - candidate.right) <= 1 &&
        Math.abs(existing.top - candidate.top) <= 1 &&
        Math.abs(existing.bottom - candidate.bottom) <= 1,
      );
      if (!duplicate) found.push(candidate);
    }
  }
  return found;
}

/** Converts with Vega's native inversion, retaining log, time, and symlog semantics. */
export function invertAxisRange(scale: Pick<Scale, 'invert' | 'copy'>, firstPixel: number, lastPixel: number): [number, number] | null {
  // Log chart marks are clamped; interaction must extrapolate without changing rendering.
  const copy = scale.copy?.();
  copy?.clamp?.(false);
  const inverse = copy ?? scale;
  if (typeof inverse.invert !== 'function') return null;
  const first = numeric(inverse.invert(firstPixel)), last = numeric(inverse.invert(lastPixel));
  return first === null || last === null ? null : first <= last ? [first, last] : [last, first];
}

/** One wheel notch changes the span by 10%, anchored at the pointer. */
export function zoomAxisRange(scale: Pick<Scale, 'invert' | 'copy'>, pixels: readonly [number, number], pointer: number, delta: number): [number, number] | null {
  const factor = delta < 0 ? 0.9 : delta > 0 ? 1.1 : 1;
  return invertAxisRange(scale, pointer + (pixels[0] - pointer) * factor, pointer + (pixels[1] - pointer) * factor);
}
function normalizedForEmit(scale: Scale, range: [number, number], pixel: number): [number, number] {
  let temporal = false;
  try { temporal = scale.invert?.(pixel) instanceof Date; } catch { /* Range was already validated. */ }
  if (temporal) return range;
  const normalize = (value: number): number => {
    if (value === 0) return 0;
    const factor = 10 ** (5 - Math.floor(Math.log10(Math.abs(value))));
    return Math.round(value * factor) / factor;
  };
  return [normalize(range[0]), normalize(range[1])];
}
function overlay(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  node.style.position = 'absolute'; node.style.boxSizing = 'border-box'; node.style.zIndex = '2';
  return node;
}
function pixels(node: HTMLElement, left: number, top: number, width: number, height: number): void {
  node.style.left = `${left}px`; node.style.top = `${top}px`; node.style.width = `${Math.max(0, width)}px`; node.style.height = `${Math.max(0, height)}px`;
}

function contextAffordance(band: HTMLElement, axis: 'x' | 'y' | 'color'): void {
  band.tabIndex = 0;
  band.setAttribute('role', 'group');
  band.setAttribute('aria-label', axis === 'color' ? 'Colour legend' : `${axis.toUpperCase()} axis`);
  const open = (event: Event): void => {
    event.preventDefault(); event.stopPropagation();
    const rect = band.getBoundingClientRect();
    const pointer = event instanceof MouseEvent && event.type === 'contextmenu';
    band.dispatchEvent(new CustomEvent('elementcontext', { bubbles: true,
      detail: { axis, x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.top } }));
  };
  band.addEventListener('contextmenu', open);
  band.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);
  });
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'vega-element-menu-button'; button.textContent = '⋯';
  button.setAttribute('aria-label', axis === 'color' ? 'Colour legend options' : `${axis.toUpperCase()} axis options`);
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('dblclick', event => event.stopPropagation());
  button.addEventListener('click', open);
  band.append(button);
}

/** Vega legend groups carry bounds in their parent's coordinate system. */
function legendBounds(view: VegaAxisBandView): Bounds[] {
  const found: Bounds[] = [];
  const hasGradient = (node: unknown): boolean => {
    const item = record(node);
    return !!item && (item['role'] === 'legend-gradient' || (Array.isArray(item['items']) && item['items'].some(hasGradient)));
  };
  const visit = (node: unknown, parent: Point): void => {
    const item = record(node);
    if (!item) return;
    const mark = record(item['mark']);
    const bounds = record(item['bounds']);
    if (mark?.['role'] === 'legend' && bounds && hasGradient(item)) {
      const left = property(bounds, 'x1'), right = property(bounds, 'x2'), top = property(bounds, 'y1'), bottom = property(bounds, 'y2');
      if (left !== null && right !== null && top !== null && bottom !== null) found.push({ left: parent.x + left, right: parent.x + right, top: parent.y + top, bottom: parent.y + bottom });
      return;
    }
    const offset = mark?.['marktype'] === 'group' ? { x: parent.x + (property(item, 'x') ?? 0), y: parent.y + (property(item, 'y') ?? 0) } : parent;
    if (Array.isArray(item['items'])) for (const child of item['items']) visit(child, offset);
  };
  try { visit(record(view.scenegraph?.())?.['root'], { x: 0, y: 0 }); } catch { /* An unfinished view has no legends yet. */ }
  return found;
}

/** Adds disjoint 24px targets over bottom and left Vega axis labels. */
export function attachAxisBandGestures(host: HTMLElement, view: VegaAxisBandView, emit: (event: AxisRangeEvent) => void): AxisBandGestures {
  const originalPosition = host.style.position;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const outline = overlay('vega-axis-range-outline');
  outline.style.pointerEvents = 'none'; outline.style.display = 'none';
  outline.style.border = '1px solid var(--action-ink, #8a5a00)';
  outline.style.background = 'color-mix(in srgb, var(--amber, #f6c550) 16%, transparent)';
  host.append(outline);
  let active: { geometry: Geometry; pointerId: number; start: number; current: number; moved: boolean } | undefined;
  let bands: HTMLElement[] = [];
  let refreshPending = false;
  let wheel: { geometry: Geometry; scale: Scale; pixels: [number, number]; timer: ReturnType<typeof setTimeout> } | undefined;
  const cancelWheel = (): void => { if (wheel) clearTimeout(wheel.timer); wheel = undefined; };
  const hide = (): void => { outline.style.display = 'none'; };
  const pointerPosition = (event: PointerEvent, item: Geometry): number => {
    const rect = host.getBoundingClientRect();
    const raw = item.axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top;
    return raw;
  };
  const draw = (item: Geometry, first: number, last: number): void => {
    outline.style.display = 'block';
    if (item.axis === 'x') pixels(outline, Math.min(first, last), item.top, Math.abs(last - first), item.bottom - item.top);
    else pixels(outline, item.left, Math.min(first, last), item.right - item.left, Math.abs(last - first));
  };
  const finish = (event: PointerEvent, cancelled: boolean): void => {
    if (!active || active.pointerId !== event.pointerId) return;
    const gesture = active; active = undefined;
    gesture.current = pointerPosition(event, gesture.geometry);
    gesture.moved ||= Math.abs(gesture.current - gesture.start) > 1;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    hide();
    if (!cancelled && gesture.moved) {
      const selected = invertAxisRange(gesture.geometry.scale, gesture.start - gesture.geometry.offset, gesture.current - gesture.geometry.offset);
      if (selected) emit({ axis: gesture.geometry.axis, range: normalizedForEmit(gesture.geometry.scale, selected, gesture.start - gesture.geometry.offset) });
    }
    if (refreshPending) {
      refreshPending = false;
      refresh();
    }
  };
  const addBand = (item: Geometry): void => {
    const band = overlay(`vega-axis-band vega-axis-band-${item.axis}`);
    band.style.cursor = item.axis === 'x' ? 'ew-resize' : 'ns-resize';
    if (item.axis === 'x') pixels(band, item.left, item.bottom, item.right - item.left, BAND_SIZE);
    else pixels(band, item.left - BAND_SIZE, item.top, BAND_SIZE, item.bottom - item.top);
    contextAffordance(band, item.axis);
    band.addEventListener('wheel', event => {
      if (!Number.isFinite(event.deltaY) || !event.deltaY || active || item.end <= item.start) return;
      event.preventDefault(); event.stopPropagation();
      if (wheel && wheel.geometry !== item) commitWheel();
      const previous = wheel?.pixels ?? [item.start - item.offset, item.end - item.offset];
      const zoomScale = wheel?.scale ?? item.scale.copy?.() ?? item.scale;
      const rect = host.getBoundingClientRect();
      const position = (item.axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top) - item.offset;
      const fraction = (position - (item.start - item.offset)) / (item.end - item.start);
      const anchor = previous[0] + fraction * (previous[1] - previous[0]);
      const factor = event.deltaY < 0 ? 0.9 : 1.1;
      const next: [number, number] = [anchor + (previous[0] - anchor) * factor, anchor + (previous[1] - anchor) * factor];
      const selected = zoomAxisRange(zoomScale, previous as [number, number], anchor, event.deltaY);
      if (!selected || selected[0] >= selected[1]) return;
      cancelWheel();
      wheel = { geometry: item, scale: zoomScale, pixels: next, timer: setTimeout(commitWheel, 500) };
      draw(item, next[0] + item.offset, next[1] + item.offset);
    }, { passive: false });
    band.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      cancelWheel();
      event.preventDefault(); event.stopPropagation();
      const start = pointerPosition(event, item);
      active = { geometry: item, pointerId: event.pointerId, start, current: start, moved: false };
      band.setPointerCapture(event.pointerId); draw(item, start, start);
    });
    band.addEventListener('pointermove', event => {
      if (!active || active.geometry !== item || active.pointerId !== event.pointerId) return;
      active.current = pointerPosition(event, item); active.moved ||= Math.abs(active.current - active.start) > 1;
      draw(item, active.start, active.current);
    });
    band.addEventListener('pointerup', event => finish(event, false));
    band.addEventListener('pointercancel', event => finish(event, true));
    band.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); cancelWheel(); hide(); emit({ axis: item.axis, range: 'auto' }); });
    host.append(band); bands.push(band);
  };
  const commitWheel = (): void => {
    const pending = wheel;
    cancelWheel(); hide();
    if (!pending) return;
    const selected = invertAxisRange(pending.scale, ...pending.pixels);
    if (selected) emit({ axis: pending.geometry.axis, range: normalizedForEmit(pending.scale, selected, pending.pixels[0]) });
    if (refreshPending) { refreshPending = false; refresh(); }
  };
  const refresh = (): void => {
    if (active || wheel) {
      refreshPending = true;
      return;
    }
    hide();
    for (const band of bands) band.remove();
    bands = [];
    for (const item of geometries(host, view)) addBand(item);
    const base = baseOffset(host, view);
    for (const bounds of legendBounds(view)) {
      const band = overlay('vega-color-legend-band');
      pixels(band, base.x + bounds.left, base.y + bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
      contextAffordance(band, 'color');
      host.append(band); bands.push(band);
    }
  };
  refresh();
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh);
  observer?.observe(host);
  return { refresh, destroy: () => { observer?.disconnect(); cancelWheel(); active = undefined; for (const band of bands) band.remove(); outline.remove(); host.style.position = originalPosition; } };
}
