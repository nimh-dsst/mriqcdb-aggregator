import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { CompareInput } from '../compare-input';
import type { CardControls } from './card-projection';
import type { CohortLegendEntry } from '../../view/panel-view';
import { parseGroupCohortId, type Panel } from '../../graph/state';
import { bucketName } from '../../graph/queries';
import { seriesKey, withoutGroup, type Series } from '../../graph/series';
import type { PanelPatch } from '../../graph/commands';
@Component({
  selector: 'app-series-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, LucideAngularModule, CompareInput],
  providers: [],
  templateUrl: './series-chips.html',
  styles: `:host { display: contents; }`,
})
export class SeriesChips {
  readonly panel = input.required<Panel>();
  readonly controls = input.required<CardControls>();
  readonly legend = input<readonly CohortLegendEntry[]>([]);
  readonly isolatedId = input<string | null>(null);
  readonly editing = input(false);
  readonly isolatedChange = output<string | null>();
  readonly edit = output<void>();
  readonly added = output<Series>();
  readonly removed = output<string>();
  readonly newGroup = output<void>();
  readonly groupAction = output<{ id: string; action: 'save' | 'only' }>();
  readonly patch = output<PanelPatch>();
  /**
   * Hide one group of a split. The legend id names the group: a field value
   * for a field split ("Other" folds away by pinning the values on show), a
   * group name for a custom split.
   */
  removeGroup(event: { id: string; descriptorKey: string }): void {
    const panel = this.panel();
    const split = panel?.series.find(item => seriesKey(item) === event.descriptorKey);
    if (!panel || !split) return;
    const shown = this.legend().flatMap(item => {
      const parsed = item.descriptorKey === event.descriptorKey ? parseGroupCohortId(item.id) : null;
      return parsed && !parsed.value.startsWith('other:') ? [parsed.value] : [];
    });
    const group = bucketName(event.id) ?? parseGroupCohortId(event.id)?.value ?? event.id;
    const next = group.startsWith('other:')
      ? (split.kind === 'field' ? { kind: 'values' as const, field: split.field, values: shown } : split)
      : withoutGroup(split, group, shown);
    const series = panel.series.flatMap(item => item === split ? (next ? [next] : []) : [item]);
    this.patch.emit({ series });
  }

  /** A custom split replaces the panel's current split, if it has one. */
  applySplit(split: Series): void {
    const panel = this.panel();
    if (!panel) return;
    const kept = panel.series.filter(item => item.kind !== 'field' && item.kind !== 'values' && item.kind !== 'buckets');
    this.patch.emit({ series: [split, ...kept] });
  }


}
