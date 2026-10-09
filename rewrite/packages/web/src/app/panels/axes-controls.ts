import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PanelView } from '../view/panel-view';
import type { PanelOptions } from '../graph/state';
import { axisType } from '../graph/panel-shapes';

@Component({
  selector: 'app-axes-controls', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="flex flex-col gap-2"><legend class="field-label">Axes</legend>
      @for (axis of axes(); track axis) {
        <div class="flex items-center gap-1 text-caption" [attr.data-testid]="axis + '-axis-controls'">
          <span class="w-3">{{ axis.toUpperCase() }}</span>
          @if (!(axis === 'x' && view().panel.x === 'created_at') && !(axis === 'y' && view().panel.y === null)) {
          <select class="min-w-0 rounded border border-border bg-surface p-1" [attr.aria-label]="axis.toUpperCase() + ' scale'"
            [value]="axis === 'x' ? view().panel.options.xScale : view().panel.options.yScale" (change)="scale(axis, $event)">
            <option value="linear">Linear</option>
            @if (axis === 'x' ? view().xPositive : view().yPositive) { <option value="log">Log</option> }
            <option value="symlog">Symlog</option>
          </select>
          }
          <input #lo type="number" class="w-16 min-w-0 rounded border border-border bg-surface p-1" placeholder="Auto"
            [attr.aria-label]="axis.toUpperCase() + ' minimum'" [value]="bound(axis, 0)" (change)="range(axis, lo.value, hi.value)" />
          <span>–</span>
          <input #hi type="number" class="w-16 min-w-0 rounded border border-border bg-surface p-1" placeholder="Auto"
            [attr.aria-label]="axis.toUpperCase() + ' maximum'" [value]="bound(axis, 1)" (change)="range(axis, lo.value, hi.value)" />
          <span>{{ unit(axis) }}</span>
          <button type="button" class="text-action-ink underline" (click)="reset(axis)" [attr.aria-label]="axis.toUpperCase() + ' automatic range'">Auto</button>
        </div>
      }
      @if (view().panel.y === null) {
        <label class="flex items-center gap-2 text-caption">Y
          <select class="rounded border border-border bg-surface p-1" aria-label="Y mode" [value]="view().panel.options.yMode" (change)="mode($event)">
            <option value="count">Count</option><option value="share">Share</option><option value="logCount">Log count</option>
          </select>
        </label>
      }
    </fieldset>`,
})
export class AxesControls {
  readonly view = input.required<PanelView>();
  readonly yUnit = input<string | undefined>();
  readonly changed = output<Partial<PanelOptions>>();
  protected axes(): readonly ('x' | 'y')[] {
    return axisType(this.view().panel.x) === 'categorical' ? ['y'] : ['x', 'y'];
  }
  protected unit(axis: 'x' | 'y'): string {
    const panel = this.view().panel;
    if (axis === 'x') return panel.x === 'created_at' ? 'UTC milliseconds' : this.view().metricHelp?.unit || 'unitless';
    return panel.y ? this.yUnit() || 'unitless' : panel.options.yMode === 'share' ? 'share' : 'count';
  }
  protected bound(axis: 'x' | 'y', index: number): number | string {
    const value = axis === 'x' ? this.view().panel.options.xRange : this.view().panel.options.yRange;
    return value === 'auto' ? '' : value[index];
  }
  protected scale(axis: 'x' | 'y', event: Event): void {
    this.changed.emit({ [axis === 'x' ? 'xScale' : 'yScale']: (event.target as HTMLSelectElement).value });
  }
  protected mode(event: Event): void { this.changed.emit({ yMode: (event.target as HTMLSelectElement).value as PanelOptions['yMode'] }); }
  protected reset(axis: 'x' | 'y'): void { this.changed.emit({ [axis === 'x' ? 'xRange' : 'yRange']: 'auto' }); }
  protected range(axis: 'x' | 'y', lo: string, hi: string): void {
    if (lo === '' && hi === '') return this.reset(axis);
    if (lo === '' || hi === '' || !Number.isFinite(+lo) || !Number.isFinite(+hi) || +lo >= +hi) return;
    this.changed.emit({ [axis === 'x' ? 'xRange' : 'yRange']: [+lo, +hi] });
  }
}
