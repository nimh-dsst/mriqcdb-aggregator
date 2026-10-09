import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { asColumnId } from '@mriqc/shared';
import type { PanelView } from '../../slices/panels/view';
import type { Command } from '../../loop/commands';
import type { PanelPatch } from '../../slices/panels/commands';
import { SampleTable } from '../sample-table';
import { type Brush2dRange, type BrushRange, type VegaInput, VegaViewDirective } from '../vega-view.directive';
type ChartDatum = { readonly x: string; readonly y: string };
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

const dimmedSpec = (spec: unknown, isolatedId: string | null): unknown => {
  if (!isolatedId) {
    return spec;
  }

  const copy = structuredClone(spec);
  const test = [
    `datum.id === ${JSON.stringify(isolatedId)}`,
    `datum.cohort === ${JSON.stringify(isolatedId)}`,
    `datum.series === ${JSON.stringify(isolatedId)}`,
    `datum.seriesId === ${JSON.stringify(isolatedId)}`,
  ].join(' || ');
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }

    const encoding = asRecord(record['encoding']);
    if (encoding) {
      encoding['opacity'] = {
        condition: { test, value: 1 },
        value: 0.18,
      };
    }
    Object.values(record).forEach(visit);
  };

  visit(copy);
  return copy;
};


@Component({
  selector: 'app-chart-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SampleTable, VegaViewDirective],
  templateUrl: './chart-host.html',
  styles: `:host { display: contents; }`,
})
export class ChartHost {
  readonly view = input.required<PanelView>();
  readonly isolatedId = input<string | null>(null);
  readonly command = output<Command>();
  readonly patch = output<PanelPatch>();
  readonly context = output<Event>();
  readonly retry = output<string>();
  readonly requestPage = output<string | null>();
  readonly axisRange = output<{ axis: 'x' | 'y'; range: [number, number] | 'auto' }>();
  readonly panel = computed(() => this.view().panel);
  contextKey(event: KeyboardEvent): void {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) this.context.emit(event);
  }
  readonly vegaInput = computed<VegaInput | null>(() => {
    const view = this.view();
    if (!view) {
      return null;
    }
    const isolatedId = this.isolatedId();
    return {
      specKey: `${view.specKey}:${isolatedId ?? 'all'}`,
      spec: dimmedSpec(view.spec, isolatedId) as VegaInput['spec'],
      live: view.live,
      datasets: view.datasets,
    };
  });

  onBrush(range: BrushRange): void {
    const panel = this.panel();
    if (panel) {
      this.command.emit({
        t: 'brush',
        from: panel.id,
        metric: asColumnId(String(panel.x)),
        range,
      });
    }
  }

  onBrush2d(ranges: Brush2dRange): void {
    const panel = this.panel();
    if (panel?.y) {
      this.command.emit({
        t: 'brush2d',
        from: panel.id,
        x: asColumnId(String(panel.x)),
        y: panel.y,
        ranges,
      });
    }
  }

  onCell(cell: ChartDatum): void {
    this.patch.emit({
      x: asColumnId(cell.x),
      y: asColumnId(cell.y),
      form: 'heatmap',
    });
  }


}
