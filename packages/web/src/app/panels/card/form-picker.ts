import { ChangeDetectionStrategy, Component, computed, input, output, inject, Injector, ElementRef, viewChild, afterNextRender, DestroyRef } from '@angular/core';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import { FormGlyph } from '../form-glyphs';
import { axisType, FORM_INFO, panelFormAvailability } from '../../graph/panel-shapes';
import type { Form, Panel } from '../../graph/state';
@Component({
  selector: 'app-form-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatSelectModule, FormGlyph],
  templateUrl: './form-picker.html',
  styles: `:host { display: contents; } .form-select { min-width: 130px; min-height: 36px; display: inline-flex; align-items: center; }`,
})
export class FormPicker {
  readonly panel = input.required<Panel>();
  readonly forms = input.required<ReturnType<typeof panelFormAvailability>>();
  readonly selected = output<Form>();
  readonly secondMetric = output<Form | null>();
  private readonly injector = inject(Injector);
  private readonly formPickerElement = viewChild<unknown, ElementRef<HTMLElement>>('formPicker', { read: ElementRef });
  private clearFormLinkListeners = () => {};
  readonly formInfo = computed(() => FORM_INFO[this.panel().form]);
  readonly formWidth = computed(() => Math.max(130, 66 + Math.max(0, ...this.forms().map(entry => FORM_INFO[entry.form].label.length)) * 8));
  constructor() { inject(DestroyRef).onDestroy(() => this.clearFormLinkListeners()); }
  changeForm(form: Form): void {
    if (this.forms().some(entry => entry.form === form && entry.state === 'enabled')) this.selected.emit(form);
  }
  addSecondMetric(event: Event, picker: MatSelect, form?: Form): void {
    event.preventDefault();
    event.stopPropagation();
    picker.close();
    const linkedForm = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.form-reason')?.dataset['form'] : undefined;
    this.secondMetric.emit(form ?? (linkedForm as Form | undefined) ?? null);
  }
  prepareFormLinks(open: boolean, picker: MatSelect): void {
    this.clearFormLinkListeners();
    if (open) afterNextRender(() => this.attachFormLinks(picker), { injector: this.injector });
  }

  private attachFormLinks(picker: MatSelect): void {
    if (!picker.panelOpen || !picker.panel) return;
    const panel: HTMLElement = picker.panel.nativeElement;
    const trigger = this.formPickerElement()?.nativeElement;
    // MatSelect normally closes on Tab. Let keyboard users reach the reasons.
    const onKeydown = (event: KeyboardEvent) => {
      const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>('.form-reason'));
      if (!links.length) return;
      const index = links.indexOf(event.target as HTMLAnchorElement);
      if (event.key === 'Tab') {
        const next = index + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < links.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          links[next].focus();
        }
      } else if (index >= 0 && event.key !== 'Escape') {
        event.stopImmediatePropagation();
        if (event.key === 'Enter' || event.key === ' ') this.addSecondMetric(event, picker);
      }
    };
    panel.addEventListener('keydown', onKeydown, true);
    trigger?.addEventListener('keydown', onKeydown, true);
    this.clearFormLinkListeners = () => {
      panel.removeEventListener('keydown', onKeydown, true);
      trigger?.removeEventListener('keydown', onKeydown, true);
    };
  }

  formDetails(form: Form) {
    if (form === 'bars' && this.panel() && axisType(this.panel()!.x) === 'categorical') {
      return { ...FORM_INFO.bars, hint: 'Counts in each category' };
    }
    return FORM_INFO[form];
  }


}
