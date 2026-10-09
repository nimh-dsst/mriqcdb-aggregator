import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { SettingRow } from '../setting-row';
import type { Panel, PanelOptions } from '../../graph/state';
import { axisType } from '../../forms/availability';
import { canStack } from '../../slices/panels/model';
@Component({
  selector: 'app-card-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, SettingRow],
  providers: [],
  templateUrl: './card-options.html',
  styles: `:host { display: contents; }`,
})
export class CardOptions {
  readonly panel = input.required<Panel>();
  readonly patch = output<Partial<PanelOptions>>();
  readonly axis = output<'x' | 'y' | 'color'>();
  readonly numericX = computed(() => axisType(this.panel().x) === 'numeric');
  readonly canStack = computed(() => canStack(this.panel()));
}
