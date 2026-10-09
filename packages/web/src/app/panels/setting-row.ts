import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Shared menu row: the label keeps its space and every control has 120px. */
@Component({
  selector: 'label[appSettingRow]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'setting-row' },
  template: '<ng-content />',
})
export class SettingRow {}
