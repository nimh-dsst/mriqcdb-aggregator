import { ChangeDetectionStrategy, Component, input, output, signal, inject, ViewContainerRef, TemplateRef, viewChild } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import type { MetricDef } from '@mriqc/shared';
import { ElementControls, type NumericRange } from '../element-controls';
import type { Panel, PanelOptions } from '../../graph/state';
import { ContextMenuService } from './context-menu.service';
@Component({
  selector: 'app-axis-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, ElementControls],
  providers: [ContextMenuService],
  templateUrl: './axis-menu.html',
  styles: `:host { display: contents; }`,
})
export class AxisMenu {
  readonly panel = input.required<Panel>();
  readonly metrics = input.required<readonly MetricDef[]>();
  readonly hasBrush = input(false);
  readonly action = output<'zoom' | 'reset' | 'maximize' | 'export' | 'copy'>();
  readonly patch = output<Partial<PanelOptions>>();
  readonly contextTarget = signal<'x' | 'y' | 'color' | 'body'>('body');
  readonly rangeMemory = new Map<string, NumericRange>();
  readonly menu = inject(ContextMenuService);
  private readonly container = inject(ViewContainerRef);
  private readonly contents = viewChild.required<TemplateRef<unknown>>('contents');
  contextUnit(axis: 'x' | 'y' | 'color'): string {
    if (axis === 'color') return '';
    const column = axis === 'x' ? this.panel()?.x : this.panel()?.y;
    if (column === 'created_at') return 'UTC milliseconds';
    if (!column) return this.panel()?.options.yMode === 'share' ? 'share' : 'count';
    return this.metrics().find(metric => metric.id === column)?.unit || 'unitless';
  }

  open(event: Event, target: 'x' | 'y' | 'color' | 'body'): void {
    event.preventDefault(); event.stopPropagation();
    const opener = event.target instanceof HTMLElement ? event.target : null;
    const rect = opener?.getBoundingClientRect();
    const mouse = event instanceof MouseEvent;
    this.openAt(target, mouse ? event.clientX : rect?.left ?? 0, mouse ? event.clientY : rect?.top ?? 0, opener);
  }
  openElement(event: Event): void {
    const detail = (event as CustomEvent<{axis: 'x' | 'y' | 'color'; x: number; y: number}>).detail;
    if (!detail) return;
    event.stopPropagation();
    this.openAt(detail.axis, detail.x, detail.y, event.target instanceof HTMLElement ? event.target : null);
  }
  openOptions(event: { target: 'x' | 'y' | 'color'; opener: HTMLElement }): void {
    const rect = event.opener.getBoundingClientRect();
    this.openAt(event.target, rect.right - 320, rect.bottom + 4, event.opener);
  }
  private openAt(target: 'x' | 'y' | 'color' | 'body', x: number, y: number, opener: HTMLElement | null): void {
    this.contextTarget.set(target);
    this.menu.openAt(this.contents(), this.container, { x, y }, opener);
  }

}
