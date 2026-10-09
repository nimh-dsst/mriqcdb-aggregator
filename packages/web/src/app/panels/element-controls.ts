import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import type { PanelOptions } from '../graph/state';
import { SettingRow } from './setting-row';

export type ElementAxis = 'x' | 'y' | 'color';
export type CoordinateScale = 'linear' | 'log' | 'symlog';
export type ColourScale = 'linear' | 'log' | 'sqrt';
export type NumericRange = 'auto' | readonly [number, number];

type RangeMode = 'auto' | 'custom';

@Component({
  selector: 'app-element-controls',
  standalone: true,
  imports: [SettingRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="element-controls">
      @if (countAxis()) {
        <label appSettingRow class="control-row">
          <span>Count mode</span>
          <select aria-label="Count mode" [value]="countMode()" (change)="onCountModeChange($event)">
            <option value="count">Count</option>
            <option value="share">Share (% of group)</option>
            <option value="logCount">Log count</option>
          </select>
        </label>
      }
        <label appSettingRow class="control-row">
          <span>Scale</span>
          <select [attr.aria-label]="axis().toUpperCase() + ' scale'" [value]="scale()" (change)="onScaleChange($event)">
            @if (axis() === 'color') {
              <option value="linear" [selected]="scale() === 'linear'">Linear</option>
              <option value="log" [selected]="scale() === 'log'">Log</option>
              <option value="sqrt" [selected]="scale() === 'sqrt'">Sqrt</option>
            } @else {
              <option value="linear">Linear</option>
              <option value="log">Log</option>
              <option value="symlog">Symlog</option>
            }
          </select>
        </label>

      <label appSettingRow class="control-row">
        <span>{{ axis() === 'color' ? 'Domain' : 'Range' }}</span>
        <select [attr.aria-label]="axis() === 'color' ? 'Domain' : 'Range'" [value]="rangeMode()" (change)="onRangeModeChange($event)">
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      @if (rangeMode() === 'custom') {
        <div class="control-row bounds-row">
          <span>Custom bounds</span>
          <div class="bounds" role="group" [attr.aria-label]="boundLabel()">
            <input
              type="number"
              inputmode="decimal"
              class="bound"
              [value]="lowerBound()"
              [attr.aria-label]="boundLabel() + ' minimum'"
              (input)="onBoundInput('lower', $event)"
            />
            <span aria-hidden="true">to</span>
            <input
              type="number"
              inputmode="decimal"
              class="bound"
              [value]="upperBound()"
              [attr.aria-label]="boundLabel() + ' maximum'"
              (input)="onBoundInput('upper', $event)"
            />
            @if (unit()) {
              <span class="unit">{{ unit() }}</span>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .element-controls {
      box-sizing: border-box;
      width: 320px;
      max-height: 80vh;
      overflow: auto;
      padding: 16px;
    }

    .control-row {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      min-height: 36px;
      color: var(--ink-2);
      font-size: 12px;
    }

    select,
    input {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      font: inherit;
    }

    .bounds-row {
      display: block;
      min-height: 0;
    }

    .bounds-row > span {
      display: block;
      margin-bottom: 4px;
    }

    .bounds {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      min-height: 36px;
    }

    .bound {
      width: 88px;
      flex: 0 0 88px;
    }

    .unit {
      min-width: 0;
      overflow-wrap: anywhere;
    }
  `,
})
export class ElementControls {
  readonly options = input.required<PanelOptions>();
  readonly axis = input<ElementAxis>('x');
  readonly unit = input('');
  readonly countAxis = input(false);
  readonly colorDefault = input<Extract<ColourScale, 'linear' | 'log'>>('log');
  readonly changed = output<Partial<PanelOptions>>();
  /** Each axis's custom range per scale type, kept by the card across menu openings. */
  readonly rangeMemory = input<Map<string, NumericRange>>(new Map());

  readonly rangeMode = signal<RangeMode>('auto');
  readonly lowerBound = signal('');
  readonly upperBound = signal('');

  constructor() {
    effect(() => {
      const range = this.currentRange();
      this.rangeMode.set(range === 'auto' ? 'auto' : 'custom');
      this.lowerBound.set(range === 'auto' ? '' : String(range[0]));
      this.upperBound.set(range === 'auto' ? '' : String(range[1]));
    });
  }

  /** Values exposed for templates and focused component tests. */
  scale(): CoordinateScale | ColourScale {
    const options = this.options();
    if (this.axis() === 'color') {
      return options.colorScale ?? this.colorDefault();
    }
    return this.axis() === 'x' ? options.xScale : options.yScale;
  }

  countMode(): PanelOptions['yMode'] {
    return this.options().yMode;
  }

  boundLabel(): string {
    return this.axis() === 'color' ? 'Color domain' : `${this.axis().toUpperCase()} axis range`;
  }

  onScaleChange(event: Event): void {
    const value = this.selectValue(event);
    if (this.axis() === 'color') {
      if (value === 'linear' || value === 'log' || value === 'sqrt') {
        this.changed.emit({colorScale: value, ...this.swapRange(value)});
      }
      return;
    }

    if (value !== 'linear' && value !== 'log' && value !== 'symlog') {
      return;
    }
    if (this.countAxis() && this.axis() === 'y') {
      this.changed.emit({ yScale: value, ...this.swapRange(value), ...(this.options().yMode === 'logCount' && value !== 'log' ? { yMode: 'count' as const } : {}) });
      return;
    }
    this.changed.emit({ ...(this.axis() === 'x' ? {xScale: value} : {yScale: value}), ...this.swapRange(value) });
  }

  onCountModeChange(event: Event): void {
    const value = this.selectValue(event);
    if (value === 'count' || value === 'share' || value === 'logCount') {
      const yScale = value === 'logCount' ? 'log' : 'linear';
      this.changed.emit({ yMode: value, yScale, ...(yScale !== this.scale() ? this.swapRange(yScale) : {}) });
    }
  }

  onRangeModeChange(event: Event): void {
    if (this.selectValue(event) === 'auto') {
      this.rangeMode.set('auto');
      this.lowerBound.set('');
      this.upperBound.set('');
      this.changed.emit(this.rangePatch('auto'));
      return;
    }

    this.rangeMode.set('custom');
    if (this.currentRange() === 'auto') {
      this.lowerBound.set('');
      this.upperBound.set('');
    }
  }

  onBoundInput(bound: 'lower' | 'upper', event: Event): void {
    const value = this.inputValue(event);
    if (bound === 'lower') {
      this.lowerBound.set(value);
    } else {
      this.upperBound.set(value);
    }
    this.commitCustomRange();
  }

  private commitCustomRange(): void {
    const lowerText = this.lowerBound().trim();
    const upperText = this.upperBound().trim();
    if (!lowerText || !upperText) {
      return;
    }
    const lower = Number(lowerText);
    const upper = Number(upperText);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
      return;
    }
    if (this.axis() === 'color' && this.scale() === 'log' && (lower <= 0 || upper <= 0)) {
      return;
    }
    this.changed.emit(this.rangePatch([lower, upper]));
  }

  private currentRange(): NumericRange {
    const options = this.options();
    if (this.axis() === 'color') {
      return options.colorDomain ?? 'auto';
    }
    return this.axis() === 'x' ? options.xRange : options.yRange;
  }

  /**
   * A range set on one scale rarely fits another (a log axis cannot start at
   * 0), so switching scale stores this scale's range and brings back the one
   * last used with the new scale, or auto.
   */
  private swapRange(next: string): Partial<PanelOptions> {
    const memory = this.rangeMemory();
    memory.set(`${this.axis()}:${this.scale()}`, this.currentRange());
    return this.rangePatch(memory.get(`${this.axis()}:${next}`) ?? 'auto');
  }

  private rangePatch(range: NumericRange): Partial<PanelOptions> {
    if (this.axis() === 'color') {
      return {colorDomain: range};
    }
    return this.axis() === 'x' ? {xRange: range} : {yRange: range};
  }

  private selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  private inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
