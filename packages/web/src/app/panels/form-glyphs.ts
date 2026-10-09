import { FORM_ORDER, formDef } from '../forms/registry';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Form } from '../graph/state';

/** Hand-drawn 20 × 14 mark silhouettes, shared by the trigger and options. */
export const FORM_GLYPHS = Object.fromEntries(FORM_ORDER.map(id => [id, formDef(id).glyph])) as Record<Form, string>;

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
