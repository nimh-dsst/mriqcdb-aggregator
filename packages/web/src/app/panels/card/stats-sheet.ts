import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PanelView } from '../../slices/panels/view';
@Component({
  selector: 'app-stats-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './stats-sheet.html',
  styles: `:host { display: contents; }`,
})
export class StatsSheet {
  readonly view = input.required<PanelView>();
  readonly pair = output<{ x: string; y: string }>();
  readonly statsOpen = input(false);
}
