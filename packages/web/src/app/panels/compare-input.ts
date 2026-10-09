import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { fieldValueLabel, isNoneValue, NONE_FILTER_VALUE, type FieldDef, type MetricDef } from '@mriqc/shared';
import { LucideAngularModule, Plus, X } from 'lucide-angular';

import { cohortColor } from './specs';
import { SplitEditor } from './split-editor';
import { type Bucket, type Series, seriesDisabledReason, seriesKey, seriesLabel } from '../slices/series/model';

interface SavedGroup {
  readonly id: string;
  readonly name: string;
  readonly source?: 'population' | 'study';
}

interface FieldValue {
  readonly value: string | number | boolean | null;
  readonly n: number;
}

interface SeriesContext {
  readonly fieldCount: (field: string) => number;
  readonly studyReady: boolean;
  readonly cohortIds: readonly string[];
}

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const dateFromIso = (value: string): Date | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const shiftIsoYear = (value: string, years: number): string => {
  const date = dateFromIso(value);
  if (!date) {
    return value;
  }

  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = Math.min(
    date.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return toIsoDate(new Date(Date.UTC(year, month, day)));
};

@Component({
  selector: 'app-compare-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatMenuModule, MatSelectModule, MatTooltipModule, LucideAngularModule, SplitEditor],
  template: `
    <div class="min-w-0 space-y-2">
      <div class="flex min-w-0 flex-wrap items-center gap-1">
        <span class="shrink-0 text-caption text-ink-2">Compare</span>

          @if (legend().length) {
            @for (item of legend(); track item.id) {
              <span class="group inline-flex min-w-0 items-center rounded border border-border bg-surface" data-testid="compare-series-chip"
                (contextmenu)="openContext($event, chipMenuTrigger)" (keydown)="contextKey($event, chipMenuTrigger)">
              <button type="button" class="min-h-9 px-1 text-ink-2 opacity-0 group-hover:opacity-100 focus:opacity-100"
                [attr.aria-label]="'Actions for ' + item.name" [matMenuTriggerFor]="chipMenu" #chipMenuTrigger="matMenuTrigger">⋯</button>
              <mat-menu #chipMenu="matMenu">
                <button mat-menu-item (click)="isolatedChange.emit(item.id)">Isolate</button>
                <button mat-menu-item (click)="isolatedChange.emit(null)">Reset</button>
                @if (item.descriptorKey && isSplitItem(item.descriptorKey)) {
                  <button mat-menu-item (click)="removeLegendItem(item.id, item.descriptorKey)">Hide this group</button>
                  <button mat-menu-item (click)="openSplitEditor()">Edit split…</button>
                  <button mat-menu-item (click)="removed.emit(item.descriptorKey)">Remove the whole split</button>
                } @else if (item.descriptorKey) {
                  <button mat-menu-item (click)="removed.emit(item.descriptorKey)">Remove</button>
                }
                @if (canSaveGroup(item.descriptorKey)) {
                  <button mat-menu-item (click)="groupAction.emit({ id: item.id, action: 'save' })">Save as group…</button>
                }
                @if (canFilterGroup(item.descriptorKey)) {
                  <button mat-menu-item (click)="groupAction.emit({ id: item.id, action: 'only' })">Only this group</button>
                }
              </mat-menu>
              <button
                type="button"
                class="inline-flex min-h-9 min-w-0 items-center gap-1 px-2 text-control text-ink"
                [class.opacity-50]="isolated() !== null && isolated() !== item.id"
                [attr.aria-pressed]="isolated() === item.id"
                (click)="isolatedChange.emit(isolated() === item.id ? null : item.id)"
                (dblclick)="isolatedChange.emit(null)"
              >
                <span class="h-2 w-2 shrink-0 rounded-full" [style.background-color]="item.color" aria-hidden="true"></span>
                <span class="min-w-0 truncate">{{ item.name }}</span>
                <span class="shrink-0 text-ink-2">n={{ item.n === null ? '—' : item.n.toLocaleString('en-US') }}</span>
              </button>
              @if (item.descriptorKey) {
                <button
                  type="button"
                  class="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center text-ink-2"
                  [attr.aria-label]="(isSplitItem(item.descriptorKey) ? 'Hide group ' : 'Remove comparison ') + item.name"
                  (click)="removeLegendItem(item.id, item.descriptorKey)"
                >
                  <lucide-icon [img]="xIcon" [size]="14" aria-hidden="true" />
                </button>
              }
              </span>
            }
          }
          @for (item of series(); track keyOf(item)) {
          @if (!isSeriesRepresented(keyOf(item))) {
          <span
            class="group flex min-h-9 min-w-0 items-center gap-1 rounded border border-border bg-surface px-2 text-control text-ink"
            (contextmenu)="openContext($event, descriptorTrigger)" (keydown)="contextKey($event, descriptorTrigger)"
          >
            <span class="min-w-0 truncate">{{ labelOf(item) }}</span>
            <button type="button" class="min-h-9 px-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
              [attr.aria-label]="'Actions for ' + labelOf(item)" [matMenuTriggerFor]="descriptorMenu" #descriptorTrigger="matMenuTrigger">⋯</button>
            <mat-menu #descriptorMenu="matMenu">
              <button mat-menu-item (click)="removeSeries(item)">Remove</button>
              @if (item.kind === 'values') {
                <button mat-menu-item (click)="groupAction.emit({ id: keyOf(item), action: 'save' })">Save as group…</button>
                <button mat-menu-item (click)="groupAction.emit({ id: keyOf(item), action: 'only' })">Only this group</button>
              }
            </mat-menu>
            <button
              type="button"
              class="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center text-ink-2"
              [attr.aria-label]="'Remove comparison ' + labelOf(item)"
              (click)="removeSeries(item)"
            >
              <lucide-icon [img]="xIcon" [size]="14" aria-hidden="true" />
            </button>
          </span>
          }
        }

        <div
          class="flex min-h-9 min-w-0 items-center rounded border border-border bg-surface text-control text-ink"
        >
          @if (!series().length) {
          <input
            class="w-36 min-w-0 cursor-pointer bg-transparent px-2 outline-none"
            type="text"
            readonly
            tabindex="-1"
            aria-hidden="true"
            placeholder="Split or compare…"
            (click)="addTrigger.openMenu()"
          />
          }
          <button
            type="button"
            class="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center"
            aria-label="Add comparison"
            [matMenuTriggerFor]="comparisonMenu"
            #addTrigger="matMenuTrigger"
          >
            <lucide-icon [img]="plusIcon" [size]="16" aria-hidden="true" />
          </button>
        </div>
      </div>

      @if (splitEditorOpen()) {
        <app-split-editor
          [fields]="fieldOptions()"
          [metrics]="metrics()"
          [fieldValues]="fieldValues()"
          [initial]="splitSeed()"
          [colors]="splitColors"
          (applied)="applySplit($event)"
          (cancelled)="splitEditorOpen.set(false)"
        />
      }

      @if (valuesEditorOpen()) {
        <section class="space-y-2 rounded border border-border bg-surface p-2">
          <label class="block space-y-1">
            <span class="text-caption text-ink-2">Choose field</span>
            <mat-select
              class="block rounded border border-border px-2 py-1 text-control text-ink"
              aria-label="Choose field"
              [value]="chosenFieldId()"
              (selectionChange)="setChosenField($event.value)"
            >
              @for (field of fieldOptions(); track field.id) {
                <mat-option [value]="field.id">{{ field.label }}</mat-option>
              }
            </mat-select>
          </label>

          <label class="block space-y-1">
            <span class="text-caption text-ink-2">Choose values</span>
            <mat-select
              class="block rounded border border-border px-2 py-1 text-control text-ink"
              aria-label="Choose values"
              multiple
              [disabled]="!chosenField()"
              [value]="chosenValues()"
              (selectionChange)="setChosenValues($event.value)"
            >
              @for (fieldValue of valuesForChosenField(); track valueKey(fieldValue.value)) {
                <mat-option [value]="valueKey(fieldValue.value)">
                  {{ valueLabel(fieldValue) }}
                </mat-option>
              }
            </mat-select>
          </label>

          @let chosenValuesCandidate = valuesCandidate();
          @let chosenValuesReason = chosenValuesCandidate ? disabledReason(chosenValuesCandidate) : null;
          <div [matTooltip]="chosenValuesReason ?? ''" [matTooltipDisabled]="!chosenValuesReason">
            <button
              type="button"
              class="min-h-9 rounded border border-border px-2 text-control text-ink disabled:cursor-not-allowed disabled:opacity-50"
              [disabled]="!chosenValuesCandidate || chosenValuesReason !== null"
              (click)="addChosenValues()"
            >
              Add values
            </button>
            <button type="button" class="min-h-9 px-2 text-control text-ink" (click)="valuesEditorOpen.set(false)">Cancel</button>
          </div>
          @if (chosenValuesReason) {
            <p class="truncate text-caption text-ink-2">{{ chosenValuesReason }}</p>
          }
        </section>
      }
    </div>

    <mat-menu #comparisonMenu="matMenu">
      <div class="px-3 py-1 text-caption text-ink-2">By field</div>
      @for (field of fieldOptions(); track field.id) {
        @let fieldCandidate = fieldSeries(field);
        @let fieldReason = disabledReason(fieldCandidate);
        <div [matTooltip]="fieldReason ?? ''" [matTooltipDisabled]="!fieldReason">
          <button
            mat-menu-item
            [disabled]="fieldReason !== null"
            (click)="addCandidate(fieldCandidate)"
          >
            <span>{{ field.label }}</span>
            @if (fieldReason) {
              <span class="block truncate text-caption text-ink-2">{{ fieldReason }}</span>
            }
          </button>
        </div>
      }

      <button mat-menu-item (click)="openSplitEditor()">Custom split…</button>
      <button mat-menu-item (click)="openValuesEditor()">Chosen values…</button>

      <div class="px-3 py-1 text-caption text-ink-2">Against</div>
      @let populationCandidate = populationSeries();
      @let populationReason = disabledReason(populationCandidate);
      <div [matTooltip]="populationReason ?? ''" [matTooltipDisabled]="!populationReason">
        <button
          mat-menu-item
          [disabled]="populationReason !== null"
          (click)="addCandidate(populationCandidate)"
        >
          <span>Whole population</span>
          @if (populationReason) {
            <span class="block truncate text-caption text-ink-2">{{ populationReason }}</span>
          }
        </button>
      </div>

      @let studyCandidate = studySeries();
      @let studyReason = disabledReason(studyCandidate);
      <div [matTooltip]="studyReason ?? ''" [matTooltipDisabled]="!studyReason">
        <button
          mat-menu-item
          [disabled]="studyReason !== null"
          (click)="addCandidate(studyCandidate)"
        >
          <span>My study</span>
          @if (studyReason) {
            <span class="block truncate text-caption text-ink-2">{{ studyReason }}</span>
          }
        </button>
      </div>

      @for (group of groups(); track group.id) {
        @let groupCandidate = cohortSeries(group.id);
        @let groupReason = disabledReason(groupCandidate);
        <div [matTooltip]="groupReason ?? ''" [matTooltipDisabled]="!groupReason">
          <button
            mat-menu-item
            [disabled]="groupReason !== null"
            (click)="addCandidate(groupCandidate)"
          >
            <span>{{ group.name }}</span>
            @if (groupReason) {
              <span class="block truncate text-caption text-ink-2">{{ groupReason }}</span>
            }
          </button>
        </div>
      }

      <button mat-menu-item [matMenuTriggerFor]="earlierSpanMenu">Earlier span…</button>
      <button mat-menu-item (click)="newGroup.emit()">New group…</button>
    </mat-menu>

    <mat-menu #earlierSpanMenu="matMenu">
      @let previousYearCandidate = previousYearSeries();
      @let previousYearReason = disabledReason(previousYearCandidate);
      <div [matTooltip]="previousYearReason ?? ''" [matTooltipDisabled]="!previousYearReason">
        <button
          mat-menu-item
          [disabled]="previousYearReason !== null"
          (click)="addCandidate(previousYearCandidate)"
        >
          <span>Previous year</span>
          @if (previousYearReason) {
            <span class="block truncate text-caption text-ink-2">{{ previousYearReason }}</span>
          }
        </button>
      </div>

      @let sameMonthsCandidate = sameMonthsLastYearSeries();
      @let sameMonthsReason = disabledReason(sameMonthsCandidate);
      <div [matTooltip]="sameMonthsReason ?? ''" [matTooltipDisabled]="!sameMonthsReason">
        <button
          mat-menu-item
          [disabled]="sameMonthsReason !== null"
          (click)="addCandidate(sameMonthsCandidate)"
        >
          <span>Same months last year</span>
          @if (sameMonthsReason) {
            <span class="block truncate text-caption text-ink-2">{{ sameMonthsReason }}</span>
          }
        </button>
      </div>

      <div class="space-y-1 px-3 py-2" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
        <label class="block text-caption text-ink-2">
          From
          <input
            class="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-control text-ink"
            type="date"
            [value]="customFrom()"
            (input)="setCustomFrom($event)"
          />
        </label>
        <label class="block text-caption text-ink-2">
          To
          <input
            class="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-control text-ink"
            type="date"
            [value]="customTo()"
            (input)="setCustomTo($event)"
          />
        </label>
        @let customCandidate = customSpanSeries();
        @let customReason = customCandidate ? disabledReason(customCandidate) : null;
        <div [matTooltip]="customReason ?? ''" [matTooltipDisabled]="!customReason">
          <button
            type="button"
            class="min-h-9 rounded border border-border px-2 text-control text-ink disabled:cursor-not-allowed disabled:opacity-50"
            [disabled]="!customCandidate || customReason !== null"
            (click)="addCustomSpan()"
          >
            Add span
          </button>
        </div>
        @if (customReason) {
          <p class="truncate text-caption text-ink-2">{{ customReason }}</p>
        }
      </div>
    </mat-menu>
  `,
})
export class CompareInput {
  readonly plusIcon = Plus;
  readonly xIcon = X;

  readonly series = input.required<readonly Series[]>();
  readonly legend = input<readonly {
    id: string;
    name: string;
    color: string;
    n: number | null;
    descriptorKey?: string;
  }[]>([]);
  readonly isolated = input<string | null>(null);
  readonly fields = input.required<readonly FieldDef[]>();
  readonly metrics = input<readonly MetricDef[]>([]);
  readonly groups = input.required<readonly SavedGroup[]>();
  readonly fieldValues = input.required<Readonly<Record<string, readonly FieldValue[]>>>();
  readonly studyReady = input(false);
  readonly studyFormReason = input<string | null>(null);
  readonly dateRange = input<readonly [string, string] | null>(null);

  readonly added = output<Series>();
  readonly removed = output<string>();
  readonly isolatedChange = output<string | null>();
  readonly newGroup = output<void>();
  readonly groupAction = output<{ id: string; action: 'save' | 'only' }>();
  /** One group of a split taken out; the card works out what the split becomes. */
  readonly groupRemoved = output<{ id: string; descriptorKey: string }>();
  /** A custom split to put in place of whatever split the panel has. */
  readonly splitApplied = output<Series>();

  readonly splitEditorOpen = signal(false);
  readonly splitColors = Array.from({ length: 5 }, (_, index) => cohortColor(index));

  isSplitItem(key: string | undefined): boolean {
    return this.series().some(item => key === seriesKey(item) && (item.kind === 'field' || item.kind === 'values' || item.kind === 'buckets'));
  }

  removeLegendItem(id: string, key: string): void {
    if (this.isSplitItem(key)) this.groupRemoved.emit({ id, descriptorKey: key });
    else this.removed.emit(key);
  }

  /**
   * What the editor opens with: the panel's split as editable groups, so a
   * manufacturer split can be renamed, merged or narrowed rather than rebuilt.
   */
  splitSeed(): readonly Bucket[] {
    const split = this.series().find(item => item.kind === 'field' || item.kind === 'values' || item.kind === 'buckets');
    if (!split) return [];
    if (split.kind === 'buckets') return split.buckets;
    if (split.kind !== 'field' && split.kind !== 'values') return [];
    const entries = [...(this.fieldValues()[split.field] ?? [])].sort((a, b) => b.n - a.n);
    const values = split.kind === 'values'
      ? split.values.map(text => entries.find(entry => this.valueKey(entry.value) === text)?.value ?? text)
      : entries.slice(0, 5).map(entry => entry.value);
    return values.map(value => ({
      name: fieldValueLabel(split.field, value),
      filters: [{ field: split.field, op: 'in' as const, values: [isNoneValue(value) ? NONE_FILTER_VALUE : value as string | number | boolean] }],
    }));
  }

  openSplitEditor(): void {
    this.valuesEditorOpen.set(false);
    this.splitEditorOpen.set(true);
  }

  applySplit(buckets: readonly Bucket[]): void {
    this.splitEditorOpen.set(false);
    this.splitApplied.emit({ kind: 'buckets', buckets });
  }

  canSaveGroup(key: string | undefined): boolean {
    return this.series().some(item => key === seriesKey(item) && (item.kind === 'field' || item.kind === 'values'));
  }

  canFilterGroup(key: string | undefined): boolean {
    return this.series().some(item => key === seriesKey(item) && item.kind !== 'study');
  }

  openContext(event: Event, trigger: MatMenuTrigger): void {
    event.preventDefault();
    event.stopPropagation();
    trigger.openMenu();
  }

  contextKey(event: KeyboardEvent, trigger: MatMenuTrigger): void {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) this.openContext(event, trigger);
  }

  isSeriesRepresented(key: string): boolean {
    return this.legend().some((item) => item.descriptorKey === key);
  }

  readonly valuesEditorOpen = signal(false);
  readonly chosenFieldId = signal<string | null>(null);
  readonly chosenValues = signal<readonly string[]>([]);
  readonly customFrom = signal('');
  readonly customTo = signal('');

  readonly fieldOptions = computed(() =>
    this.fields().filter(
      (field) => field.kind === 'categorical' && field.groupable,
    ),
  );
  readonly chosenField = computed(
    () =>
      this.fieldOptions().find((field) => field.id === this.chosenFieldId()) ??
      null,
  );
  readonly valuesForChosenField = computed(() => {
    const field = this.chosenField();
    if (!field) {
      return [];
    }

    const values = this.fieldValues()[field.id] ?? [];
    const uniqueValues = new Map<string, FieldValue>();
    for (const value of values) {
      uniqueValues.set(this.valueKey(value.value), value);
    }
    return [...uniqueValues.values()];
  });
  readonly context = computed<SeriesContext>(() => ({
    fieldCount: (field) => this.fieldValues()[field]?.length ?? 5,
    studyReady: this.studyReady(),
    cohortIds: this.groups().map((group) => group.id),
  }));

  keyOf(item: Series): string {
    return seriesKey(item);
  }

  labelOf(item: Series): string {
    return seriesLabel(item, this.fieldLabel.bind(this), this.cohortLabel.bind(this));
  }

  fieldLabel(id: string): string {
    return this.fields().find((field) => field.id === id)?.label ?? id;
  }

  cohortLabel(id: string): string {
    return this.groups().find((group) => group.id === id)?.name ?? id;
  }

  disabledReason(candidate: Series): string | null {
    if (candidate.kind === 'study' && this.studyReady() && this.studyFormReason()) return this.studyFormReason();
    const reason = seriesDisabledReason(this.series(), candidate, this.context());
    if (reason) return reason;
    const study = candidate.kind === 'study' || (candidate.kind === 'cohort' && this.groups().find(group => group.id === candidate.id)?.source === 'study');
    return study ? this.studyFormReason() : null;
  }

  fieldSeries(field: FieldDef): Series {
    return { kind: 'field', field: field.id };
  }

  populationSeries(): Series {
    return { kind: 'population' };
  }

  studySeries(): Series {
    return { kind: 'study' };
  }

  cohortSeries(id: string): Series {
    return { kind: 'cohort', id };
  }

  previousYearSeries(): Series {
    const dates = (this.dateRange() ?? [])
      .map(dateFromIso)
      .filter((date): date is Date => date !== null);
    const latest =
      dates.sort((left, right) => right.getTime() - left.getTime())[0] ?? new Date();
    const year = latest.getUTCFullYear() - 1;
    return {
      kind: 'span',
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    };
  }

  sameMonthsLastYearSeries(): Series {
    const range = this.dateRange();
    if (range) {
      return {
        kind: 'span',
        from: shiftIsoYear(range[0], -1),
        to: shiftIsoYear(range[1], -1),
      };
    }

    const end = new Date();
    const start = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 12, end.getUTCDate()),
    );
    return {
      kind: 'span',
      from: shiftIsoYear(toIsoDate(start), -1),
      to: shiftIsoYear(toIsoDate(end), -1),
    };
  }

  customSpanSeries(): Series | null {
    const from = this.customFrom();
    const to = this.customTo();
    return from && to && from <= to ? { kind: 'span', from, to } : null;
  }

  valuesCandidate(): Series | null {
    const field = this.chosenField();
    const values = this.chosenValues();
    return field && values.length > 0
      ? { kind: 'values', field: field.id, values }
      : null;
  }

  valueKey(value: FieldValue['value']): string {
    return isNoneValue(value) ? NONE_FILTER_VALUE : String(value);
  }

  valueLabel(value: FieldValue): string {
    const label = fieldValueLabel(this.chosenFieldId(), value.value);
    return `${label} (${value.n})`;
  }

  openValuesEditor(): void {
    this.valuesEditorOpen.set(true);
  }

  setChosenField(fieldId: string | null): void {
    this.chosenFieldId.set(fieldId);
    this.chosenValues.set([]);
  }

  setChosenValues(values: readonly string[]): void {
    this.chosenValues.set(values);
  }

  setCustomFrom(event: Event): void {
    this.customFrom.set((event.target as HTMLInputElement).value);
  }

  setCustomTo(event: Event): void {
    this.customTo.set((event.target as HTMLInputElement).value);
  }

  addCandidate(candidate: Series): void {
    if (this.disabledReason(candidate) === null) {
      this.added.emit(candidate);
    }
  }

  addChosenValues(): void {
    const candidate = this.valuesCandidate();
    if (candidate && this.disabledReason(candidate) === null) {
      this.addCandidate(candidate);
      this.valuesEditorOpen.set(false);
    }
  }

  addCustomSpan(): void {
    const candidate = this.customSpanSeries();
    if (candidate) {
      this.addCandidate(candidate);
    }
  }

  removeSeries(item: Series): void {
    this.removed.emit(seriesKey(item));
  }
}
