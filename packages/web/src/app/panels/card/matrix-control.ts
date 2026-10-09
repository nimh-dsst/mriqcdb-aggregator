import { ChangeDetectionStrategy, Component, computed, input, output, model } from '@angular/core';
import { asColumnId, type MetricDef } from '@mriqc/shared';
import { MatSelectModule } from '@angular/material/select';
import type { Panel, PanelOptions } from '../../graph/state';
import { axisType } from '../../forms/availability';
export interface MatrixDraft { open: boolean; metrics: readonly string[] }
@Component({
  selector: 'app-matrix-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatSelectModule],
  providers: [],
  templateUrl: './matrix-control.html',
  styles: `:host { display: contents; }`,
})
export class MatrixControl {
  readonly panel = input.required<Panel>();
  readonly metrics = input.required<readonly MetricDef[]>();
  readonly drawer = input(false);
  readonly patch = output<Partial<PanelOptions>>();
  readonly applied = output<Partial<PanelOptions>>();
  readonly numericX = computed(() => axisType(this.panel().x) === 'numeric');
  readonly draft = model<MatrixDraft>({ open: false, metrics: [] });
  readonly metricSetOpen = computed(() => this.draft().open);
  readonly correlationMetrics = computed(() => this.draft().metrics);
  openMetricSet(): void {
    const panel = this.panel();
    const metrics = (panel?.options as { readonly metrics?: readonly string[] } | undefined)
      ?.metrics;
    this.draft.set({ open: true, metrics: metrics ?? [] });
  }

  setCorrelationMetrics(metrics: readonly string[]): void {
    this.draft.update(draft => ({ ...draft, metrics }));
  }

  applyMetricSet(): void {
    const panel = this.panel();
    const metrics = this.correlationMetrics();
    if (!panel || metrics.length < 2) {
      return;
    }
    this.applied.emit({ family: 'custom', metrics: metrics.map(asColumnId) });
    this.draft.update(draft => ({ ...draft, open: false }));
  }


}
