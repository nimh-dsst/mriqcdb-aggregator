import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PanelView } from '../slices/panels/view';
import type { PanelOptions } from '../graph/state';
import { axisType } from '../forms/availability';
import { ElementControls } from './element-controls';

@Component({
  selector: 'app-axes-controls', changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ElementControls],
  template: `
    @for (axis of axes(); track axis) {
      <app-element-controls [options]="view().panel.options" [axis]="axis" [unit]="unit(axis)"
        [countAxis]="axis === 'y' && view().panel.y === null" (changed)="changed.emit($event)" />
    }`,
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
}
