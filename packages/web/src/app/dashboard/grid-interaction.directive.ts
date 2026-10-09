import {
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { Graph } from '../loop/graph';

export interface GridGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Interaction = 'move' | 'resize';

const ROW_PX = 56;
const MIN_WIDTH = 3;
const MIN_HEIGHT = 5;

/** Pointer and keyboard interaction for an explicit dashboard grid rectangle. */
@Directive({ selector: '[appGridInteraction]' })
export class GridInteractionDirective {
  readonly geometry = input.required<GridGeometry>();
  readonly columnsWide = input.required<number>();
  readonly gridPanelId = input.required<string>();
  readonly gridMaximized = input.required<boolean>();
  readonly geometryAnnouncement = output<string>();

  private readonly graph = inject(Graph);
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly document = this.host.ownerDocument;
  private readonly destroyRef = inject(DestroyRef);
  private readonly outline = this.document.createElement('div');
  private interaction: {
    kind: Interaction;
    pointerId: number;
    startX: number;
    startY: number;
    start: GridGeometry;
    next: GridGeometry;
    unitX: number;
    parentRect: DOMRect;
  } | null = null;

  constructor() {
    this.host.tabIndex = this.host.tabIndex < 0 ? 0 : this.host.tabIndex;
    this.host.addEventListener('keydown', this.onKeyDown);
    this.host.addEventListener('pointerdown', this.onPointerDown);
    this.destroyRef.onDestroy(() => {
      this.host.removeEventListener('keydown', this.onKeyDown);
      this.host.removeEventListener('pointerdown', this.onPointerDown);
      this.stopPointerListeners();
      this.removeOutline();
    });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    const gripFocused = target instanceof Element && target.matches('button[data-grid-drag]');
    if (this.disabled() || event.defaultPrevented || (target !== this.host && !gripFocused)) return;
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    const current = this.clamp(this.geometry());
    const next = { ...current };
    const delta = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    if (event.shiftKey) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') next.w += delta;
      else next.h += delta;
      Object.assign(next, this.clamp(next));
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      next.x += delta;
      Object.assign(next, this.clamp(next));
    } else {
      next.y += delta;
      Object.assign(next, this.clamp(next));
    }
    if (this.same(current, next)) return;
    event.preventDefault();
    this.dispatch(next, event.shiftKey ? 'resize' : 'move');
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.disabled() || this.interaction !== null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const marker = target.closest('[data-grid-drag], [data-grid-resize]');
    if (!marker || !this.host.contains(marker)) return;
    const control = target.closest('button, input, select, textarea, a, [role="button"]');
    if (control && !(control === marker && marker.matches('button[data-grid-drag]'))) return;

    const parent = this.host.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const unitX = (parentRect.width + 16) / 12;
    if (!Number.isFinite(unitX) || unitX <= 0) return;

    const kind: Interaction = marker.matches('[data-grid-resize]') ? 'resize' : 'move';
    const start = this.clamp(this.geometry());
    this.interaction = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start,
      next: start,
      unitX,
      parentRect,
    };
    event.preventDefault();
    if (kind === 'move') this.host.classList.add('panel-grid-dragging');
    if (marker instanceof HTMLButtonElement) marker.focus({ preventScroll: true });
    this.document.addEventListener('pointermove', this.onPointerMove);
    this.document.addEventListener('pointerup', this.onPointerUp);
    this.document.addEventListener('pointercancel', this.onPointerCancel);
    this.updateOutline(start, parentRect, unitX);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const active = this.interaction;
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = Math.round((event.clientX - active.startX) / active.unitX);
    const dy = Math.round((event.clientY - active.startY) / ROW_PX);
    const next = { ...active.start };
    if (active.kind === 'move') {
      next.x += dx;
      next.y += dy;
    } else {
      next.w += dx;
      next.h += dy;
    }
    active.next = this.clamp(next);
    this.updateOutline(active.next, active.parentRect, active.unitX);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const active = this.interaction;
    if (!active || event.pointerId !== active.pointerId) return;
    this.stopPointerListeners();
    this.removeOutline();
    if (!this.same(active.start, active.next)) this.dispatch(active.next, active.kind);
    this.interaction = null;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.interaction || event.pointerId !== this.interaction.pointerId) return;
    this.stopPointerListeners();
    this.removeOutline();
    this.interaction = null;
  };

  private disabled(): boolean {
    return this.columnsWide() < 2 || this.gridMaximized();
  }

  private clamp(value: GridGeometry): GridGeometry {
    const w = Math.max(MIN_WIDTH, Math.min(12, Math.round(value.w)));
    const h = Math.max(MIN_HEIGHT, Math.round(value.h));
    return {
      x: Math.max(0, Math.min(12 - w, Math.round(value.x))),
      y: Math.max(0, Math.round(value.y)),
      w,
      h,
    };
  }

  private same(a: GridGeometry, b: GridGeometry): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  private dispatch(next: GridGeometry, kind: Interaction): void {
    const columnsWide = this.columnsWide();
    if (kind === 'move') {
      this.graph.dispatch({
        t: 'movePanel',
        id: this.gridPanelId(),
        x: next.x,
        y: next.y,
        columnsWide,
      });
    } else {
      this.graph.dispatch({
        t: 'resizePanel',
        id: this.gridPanelId(),
        w: next.w,
        h: next.h,
        columnsWide,
      });
    }
    this.geometryAnnouncement.emit(`Width ${next.w} of 12, height ${next.h}`);
  }

  private updateOutline(geometry: GridGeometry, parentRect: DOMRect, unitX: number): void {
    if (!this.outline.isConnected) {
      this.outline.setAttribute('aria-hidden', 'true');
      this.outline.style.position = 'fixed';
      this.outline.style.pointerEvents = 'none';
      this.outline.style.zIndex = '100';
      this.outline.style.border = '2px solid var(--highlight-ink, #d97706)';
      this.outline.style.background = 'color-mix(in srgb, var(--highlight-ink, #d97706) 12%, transparent)';
      this.document.body.append(this.outline);
    }
    this.outline.style.left = `${parentRect.left + geometry.x * unitX}px`;
    this.outline.style.top = `${parentRect.top + geometry.y * ROW_PX}px`;
    this.outline.style.width = `${Math.max(0, geometry.w * unitX - 16)}px`;
    this.outline.style.height = `${Math.max(0, geometry.h * ROW_PX - 16)}px`;
  }

  private removeOutline(): void {
    this.outline.remove();
  }

  private stopPointerListeners(): void {
    this.host.classList.remove('panel-grid-dragging');
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointerup', this.onPointerUp);
    this.document.removeEventListener('pointercancel', this.onPointerCancel);
  }
}
