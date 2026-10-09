import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Form } from '../graph/state';

/** Hand-drawn 20 × 14 mark silhouettes, shared by the trigger and options. */
export const FORM_GLYPHS: Partial<Record<Form, string>> = {
  histogram: 'M1 13V9H5V13M5 13V4H9V13M9 13V1H13V13M13 13V6H17V13',
  density: 'M1 12C5 12 5 2 10 2S15 12 19 12',
  ecdf: 'M1 12H5V9H9V6H13V3H18V1',
  box: 'M1 7H5M15 7H19M1 4V10M19 4V10M5 3H15V11H5ZM10 3V11',
  table: 'M1 1H19V13H1ZM1 5H19M1 9H19M7 1V13M13 1V13',
  bars: 'M2 13V7H5V13ZM8 13V2H11V13ZM14 13V5H17V13Z',
  line: 'M1 11L5 8L9 10L14 3L19 1',
  area: 'M1 13V10L5 7L9 9L14 3L19 1V13Z',
  band: 'M1 9L6 3L12 5L19 1V7L12 11L6 9L1 13ZM1 11L6 6L12 8L19 4',
  lines: 'M1 6L6 1L12 3L19 1M1 9L6 5L12 7L19 4M1 13L6 10L12 12L19 8',
  heatmap: 'M1 1H6V6H1ZM8 1H13V6H8ZM8 8H13V13H8ZM15 8H19V13H15Z',
  scatter: 'M3 11h.1M6 7h.1M9 10h.1M11 4h.1M15 6h.1M18 2h.1',
  hexbin: 'M3 3L6 1L9 3V7L6 9L3 7ZM9 7L12 5L15 7V11L12 13L9 11ZM15 3L18 1L20 3V7L18 9L15 7',
  clusters: 'M2 10h.1M4 8h.1M6 11h.1M12 3h.1M15 2h.1M14 5h.1M17 11h.1M19 9h.1',
  share: 'M1 3H19V11H1ZM6 3V11M14 3V11',
  matrix: 'M1 1H19V13H1ZM7 1V13M13 1V13M1 5H19M1 9H19M2 2L6 4M8 6L12 8M14 10L18 12',
};

@Component({
  selector: 'app-form-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true" focusable="false">
    <path [attr.d]="path()" fill="none" stroke="currentColor" [attr.stroke-width]="dots() ? 2.5 : 1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`,
  styles: ':host { display: inline-flex; width: 20px; height: 14px; flex: 0 0 20px; }',
})
export class FormGlyph {
  readonly form = input.required<Form>();
  readonly path = computed(() => FORM_GLYPHS[this.form()]);
  readonly dots = computed(() => ['scatter', 'clusters'].includes(this.form()));
}
