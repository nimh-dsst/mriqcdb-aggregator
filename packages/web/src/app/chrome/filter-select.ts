/**
 * One categorical filter: a labelled multi-select over a field's value list,
 * with a search box once the list is long enough to need one.
 *
 * It was an `ng-template` inside the top bar, outlet twice (the primary row and
 * "More filters"). The cohort editor needs the same control over the same value
 * lists, and an embedded view cannot be shared across components -- a template
 * resolves `formControlName` against the group it is *declared* in -- so it is a
 * component now. A `ControlValueAccessor`, so both callers still drive it with
 * reactive forms: the top bar with `formControlName` inside its filters group,
 * the editor with the matching control of its own form.
 *
 * It owns one thing: what the user typed into its search box. That decides how
 * many of a field's values are on screen and nothing about what the dashboard
 * shows, so it is a local signal and never reaches the graph or the URL.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DecimalPipe, LowerCasePipe } from '@angular/common';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  NONE_FILTER_VALUE,
  categoryLabel,
  fieldValueLabel,
  isNoneValue,
  type FieldValueCount,
  type FilterValue,
} from '@mriqc/shared';
import { FILTER_SEARCH_THRESHOLD, type FilterFieldView } from '../slices/filters/view';

/** Keys that belong to the select panel, not to the search box inside it. */
const PANEL_KEYS = new Set(['Escape', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown']);

/**
 * The options a long-list filter shows: what the search matches, capped, plus
 * every value already selected.
 *
 * The cap is what keeps `institution_name` and `protocol_name` (200 values
 * each, the catalog's ceiling) from putting 200 `mat-option`s in the DOM. The
 * selected values are appended unconditionally because `mat-select` builds its
 * trigger text from the rendered options: a selection whose option is filtered
 * out would still filter the dashboard but show as nothing in the control.
 */
export function visibleFilterValues(
  values: readonly FieldValueCount[],
  selected: readonly FilterValue[],
  query: string,
): readonly FieldValueCount[] {
  if (values.length <= FILTER_SEARCH_THRESHOLD) return values;
  const q = query.trim().toLowerCase();
  const chosen = new Set(selected.map((value) => String(value)));
  const isChosen = (value: FieldValueCount['value']) =>
    chosen.has(isNoneValue(value) ? NONE_FILTER_VALUE : String(value));
  const hits = values.filter(
    (value) => q === '' || categoryLabel(value.value).toLowerCase().includes(q),
  );
  const kept = hits.slice(0, FILTER_SEARCH_THRESHOLD);
  const shown = new Set(kept);
  return [...kept, ...values.filter((value) => isChosen(value.value) && !shown.has(value))];
}

@Component({
  selector: 'app-filter-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, LowerCasePipe, MatFormFieldModule, MatSelectModule, MatTooltipModule],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: FilterSelect, multi: true },
  ],
  templateUrl: './filter-select.html',
})
export class FilterSelect implements ControlValueAccessor {
  /** The field and the value list the catalog found for it. */
  readonly entry = input.required<FilterFieldView>();
  /** What the field's name does not say on its own, or '' for a name that explains itself. */
  readonly tip = input('');

  /** The values selected, as the bound control holds them. */
  protected readonly value = signal<readonly FilterValue[]>([]);
  protected readonly disabled = signal(false);

  /** What the user typed into the search box. Ephemeral, and this component's alone. */
  private readonly search = signal('');

  /** How many values are selected, for the amber chip beside the field's name. */
  protected readonly activeCount = computed(() => this.value().length);

  /** The options to render: the whole list, or a long one narrowed by the search box. */
  protected readonly options = computed(() =>
    visibleFilterValues(this.entry().values, this.value(), this.search()),
  );

  /** How many of the field's values the search box is hiding, for its hint line. */
  protected readonly hiddenCount = computed(
    () => this.entry().values.length - this.options().length,
  );

  private onChange: (value: FilterValue[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: readonly FilterValue[] | null): void {
    this.value.set(value ?? []);
  }

  registerOnChange(fn: (value: FilterValue[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected pick(values: FilterValue[]): void {
    this.value.set(values);
    this.onChange(values);
    this.onTouched();
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /**
   * Typing in the search box must not reach `mat-select`, whose own keyboard
   * handling would treat every letter as typeahead and jump the active option
   * around. The keys that work the panel rather than the text -- closing it,
   * moving through the options, picking one -- still go through.
   */
  protected onSearchKey(event: KeyboardEvent): void {
    if (PANEL_KEYS.has(event.key)) return;
    event.stopPropagation();
  }

  /**
   * How a filter option is written: the field's own name for the value where
   * there is one ("AFNI (3dvolreg)" for `afni`), "Not reported" for the null
   * bucket, and the stored value otherwise. Display only -- `optionValue` still
   * puts the stored value in the control.
   */
  protected readonly label = fieldValueLabel;

  /**
   * What selecting a value puts in the control.
   *
   * The catalog's "no value" bucket is `null`, which a `Filter` cannot carry, so
   * it travels as the empty string and the server expands it back to
   * `IS NULL OR = ''`.
   */
  protected optionValue(value: FieldValueCount['value']): FilterValue {
    return isNoneValue(value) ? NONE_FILTER_VALUE : (value as FilterValue);
  }
}
