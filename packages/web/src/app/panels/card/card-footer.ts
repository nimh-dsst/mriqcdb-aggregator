import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { PanelView } from '../../slices/panels/view';
@Component({
  selector: 'app-card-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  templateUrl: './card-footer.html',
  styles: `:host { display: contents; }`,
})
export class CardFooter {
  readonly view = input.required<PanelView>();
}
