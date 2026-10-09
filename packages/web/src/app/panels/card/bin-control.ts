import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { axisType } from '../../forms/availability';
import { MAX_BINS, MIN_BINS, type Panel, type PanelOptions } from '../../graph/state';
const BIN_STOPS = [10, 20, 30, 40, 60, 80, 100, 150, 200];
const SOFT_MAX_BINS = 100;
@Component({
  selector: 'app-bin-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './bin-control.html',
  styles: `:host { display: contents; }`,
})
export class BinControl {
  readonly panel = input.required<Panel>();
  readonly n = input<number | null>(null);
  readonly patch = output<Partial<PanelOptions>>();
  readonly numericX = computed(() => axisType(this.panel().x) === 'numeric');
  readonly timeX = computed(() => axisType(this.panel().x) === 'time');
  readonly minBins = MIN_BINS;
  readonly hardMaxBins = MAX_BINS;
  readonly maxBins = computed(() => {
    const n = this.n();
    if (!n) return SOFT_MAX_BINS;
    return Math.max(MIN_BINS, Math.min(SOFT_MAX_BINS, BIN_STOPS.find(stop => stop >= 2 * Math.sqrt(n)) ?? MAX_BINS));
  });
  readonly maxCells = computed(() => {
    const n = this.n();
    return n ? Math.max(this.cellOptions[0], Math.sqrt(n)) : Infinity;
  });
  readonly granularities = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'year', label: 'Year' },
  ] as const;

  /** Bin size sits beside the form, not in the settings menu: it is the one people reach for. */
  readonly binsVisible = computed(() => {
    const form = this.panel()?.form;
    return form !== undefined && ['histogram', 'line', 'area', 'band', 'lines'].includes(form) && (this.timeX() || this.numericX());
  });

  readonly cellOptions = [30, 60, 120] as const;

  /** Steps through round numbers: 10, 20, 30, 40, 60, 80, 100, 150, 200. */
  stepBins(direction: 1 | -1): void {
    const panel = this.panel();
    if (!panel) return;
    const current = panel.options.bins;
    const bins = direction > 0
      ? Math.min(BIN_STOPS.find(stop => stop > current) ?? MAX_BINS, this.maxBins())
      : [...BIN_STOPS].reverse().find(stop => stop < current) ?? MIN_BINS;
    this.patch.emit({ bins });
  }

  numberChanged(event: Event): void {
    this.patch.emit({ bins: Number((event.target as HTMLInputElement).value) });
  }

}
