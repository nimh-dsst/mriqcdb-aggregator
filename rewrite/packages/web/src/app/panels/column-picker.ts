import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';
import type { FieldDef, MetricDef } from '@mriqc/shared';
import { asColumnId } from '@mriqc/shared';
import { Graph } from '../graph/graph';

type ColumnSource = 'field' | 'metric' | 'time';

export interface ColumnPickerColumn {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly family: string;
  readonly subfamily?: string;
  readonly source: ColumnSource;
  readonly unit?: string;
}

export interface ColumnPickerSection {
  readonly id: string;
  readonly label?: string;
  readonly columns: readonly ColumnPickerColumn[];
}

export interface ColumnPickerGroup {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly ColumnPickerSection[];
}

const uploadTime: ColumnPickerColumn = {
  id: 'created_at',
  label: 'Upload time',
  family: 'Time',
  source: 'time',
  unit: 'UTC date',
};

const searchTerms = (query: string): readonly string[] =>
  query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const matchesQuery = (column: ColumnPickerColumn, query: string): boolean => {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return true;
  }

  const searchable = [
    column.id,
    column.label,
    column.shortLabel,
    column.family,
    column.subfamily,
    column.unit,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();

  return terms.every((term) => searchable.includes(term));
};

/**
 * Produces the ordered, searchable groups shown by {@link ColumnPicker}.
 */
export const columnGroups = (
  metrics: readonly MetricDef[],
  fields: readonly FieldDef[],
  query: string,
): readonly ColumnPickerGroup[] => {
  const groups: ColumnPickerGroup[] = [];

  if (matchesQuery(uploadTime, query)) {
    groups.push({
      id: 'time',
      label: 'Time',
      sections: [{ id: 'time-columns', columns: [uploadTime] }],
    });
  }

  const metricFamilies = new Map<
    string,
    Map<string, ColumnPickerColumn[]>
  >();
  for (const metric of metrics) {
    const column: ColumnPickerColumn = {
      id: metric.id,
      label: metric.label,
      shortLabel: metric.shortLabel,
      family: metric.family,
      subfamily: metric.subfamily,
      source: 'metric',
      unit: metric.unit,
    };
    if (!matchesQuery(column, query)) {
      continue;
    }

    const family = metricFamilies.get(metric.family) ?? new Map();
    if (!metricFamilies.has(metric.family)) {
      metricFamilies.set(metric.family, family);
    }

    const subfamily = metric.subfamily ?? '';
    const columns = family.get(subfamily) ?? [];
    if (!family.has(subfamily)) {
      family.set(subfamily, columns);
    }
    columns.push(column);
  }

  let familyIndex = 0;
  for (const [family, subfamilies] of metricFamilies) {
    groups.push({
      id: `metric-family-${familyIndex++}`,
      label: family,
      sections: Array.from(subfamilies, ([subfamily, columns], index) => ({
        id: `metric-subfamily-${index}`,
        label: subfamily || undefined,
        columns,
      })),
    });
  }

  const fieldColumns = fields
    .filter((field) => field.kind === 'categorical' && field.groupable)
    .map<ColumnPickerColumn>((field) => ({
      id: field.id,
      label: field.label,
      family: 'Fields',
      source: 'field',
      unit: 'category',
    }))
    .filter((field) => matchesQuery(field, query));
  if (fieldColumns.length > 0) {
    groups.push({
      id: 'fields',
      label: 'Fields',
      sections: [{ id: 'field-columns', columns: fieldColumns }],
    });
  }

  return groups;
};

let nextColumnPickerId = 0;

@Component({
  selector: 'app-column-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="column-picker">
      @if (drawer()) { <h2 class="sr-only">{{ panelId() ? 'Change panel column' : 'Add a panel' }}</h2> }
      <div class="column-picker-toolbar">
      <label class="column-picker-search">
        <span class="text-caption text-ink-2">Search columns</span>
        <input
          type="search"
          class="w-full rounded border border-border bg-surface px-2 py-1 text-control text-ink"
          aria-label="Search columns"
          [value]="query()"
          (input)="setQuery($event)"
        />
      </label>
      @if (drawer()) {
        <button type="button" class="btn btn-quiet" aria-label="Close column drawer" (click)="closed.emit()">Close</button>
      }
      </div>

      <div class="column-picker-body">
      <div class="column-picker-columns">
      @if (groups().length === 0) {
        <p class="text-caption text-ink-2">No columns match your search.</p>
      }

      @for (group of groups(); track group.id) {
        <section [attr.aria-labelledby]="headingId(group.id)" class="column-picker-family">
          <h3 [id]="headingId(group.id)" class="text-caption font-medium text-ink-2">
            {{ group.label }}
          </h3>

          @for (section of group.sections; track section.id) {
            <div class="space-y-1">
              @if (section.label) {
                <h4 class="text-caption text-ink-2">{{ section.label }}</h4>
              }
              <div class="column-picker-rows">
                @for (column of section.columns; track column.id) {
                  <button
                    type="button"
                    class="column-picker-row"
                    [attr.data-column-id]="column.id"
                    [attr.aria-pressed]="column.id === selected()"
                    [disabled]="isDisabled(column)"
                    (mouseenter)="preview.set(column.id)"
                    (focus)="preview.set(column.id)"
                    (click)="pick(column, $event)"
                  >
                    <span>{{ column.label }}</span>
                    <span class="column-picker-short">{{ column.shortLabel || column.id }}{{ column.unit ? ' · ' + column.unit : '' }}</span>
                  </button>
                }
              </div>
            </div>
          }
        </section>
      }
      </div>
      @if (drawer()) {
        <aside class="column-picker-details" aria-label="Column details">
          <h3 class="font-semibold">{{ activeColumn()?.label || 'Choose a column' }}</h3>
          @if (activeMetric(); as metric) {
            <p data-testid="metric-info-family">{{ metric.family }}{{ metric.subfamily ? ' / ' + metric.subfamily : '' }}</p>
            <p data-testid="metric-info-description">{{ metric.description }}</p>
            <p>Unit: {{ metric.unit || 'unitless' }}</p>
            @if (metric.higherIsBetter !== null && metric.higherIsBetter !== undefined) {
              <p>{{ metric.higherIsBetter ? 'Higher is better' : 'Lower is better' }}</p>
            }
            @if (metric.docsUrl) { <a [href]="metric.docsUrl" target="_blank" rel="noopener">MRIQC documentation</a> }
          } @else if (activeColumn()?.source === 'time') {
            <p>When the scan was uploaded to MRIQC. Group uploads into time buckets.</p>
            <p>Unit: UTC date</p>
          } @else if (activeField(); as field) {
            <p>Group scans by {{ field.label }}.</p>
            <p>Unit: category</p>
          }
          @if (axisColumn()?.source === 'metric' || axisColumn()?.source === 'time') {
            <label class="column-picker-y">
              <span>{{ axisColumn()?.source === 'time' ? 'Metric over time (y)' : 'Second metric (y)' }}</span>
              <select [attr.aria-label]="axisColumn()?.source === 'time' ? 'Metric over time (y)' : 'Second metric (y)'"
                [value]="draftY() ?? y() ?? ''" (change)="selectY($event)">
                <option value="">{{ axisColumn()?.source === 'time' ? 'Upload counts' : 'No second metric' }}</option>
                @for (metric of metrics(); track metric.id) {
                  <option [value]="metric.id" [disabled]="metric.id === axisColumn()?.id || disabledMetrics().includes(metric.id)">{{ metric.shortLabel || metric.label }} — {{ metric.label }}</option>
                }
              </select>
            </label>
          }
          <ng-content />
          <p class="text-caption">Select a column to {{ panelId() ? 'retarget this panel' : 'add a panel' }}. Hold Shift to keep this drawer open.</p>
        </aside>
      }
      </div>
    </div>
  `,
})
export class ColumnPicker {
  private readonly injector = inject(Injector);
  readonly metrics = input.required<readonly MetricDef[]>();
  readonly fields = input.required<readonly FieldDef[]>();
  readonly selected = input<string | null>(null);
  readonly disabledMetrics = input<readonly string[]>([]);
  readonly picked = output<string>();
  readonly drawer = input(false);
  readonly panelId = input<string | null>(null);
  readonly y = input<string | null>(null);
  readonly closed = output<void>();
  readonly preview = signal<string | null>(null);
  readonly draftY = signal<string | null>(null);
  readonly activeColumn = computed(() => columnGroups(this.metrics(), this.fields(), '')
    .flatMap(group => group.sections.flatMap(section => section.columns))
    .find(column => column.id === (this.preview() ?? this.selected())) ?? uploadTime);
  readonly activeMetric = computed(() => this.metrics().find(metric => metric.id === this.activeColumn().id));
  readonly activeField = computed(() => this.fields().find(field => field.id === this.activeColumn().id));
  // Hover previews help, but must never silently retarget the edited card's x.
  readonly axisColumn = computed(() => this.panelId()
    ? columnGroups(this.metrics(), this.fields(), '').flatMap(group => group.sections.flatMap(section => section.columns))
      .find(column => column.id === this.selected()) ?? this.activeColumn()
    : this.activeColumn());

  readonly query = signal('');
  readonly groups = computed(() =>
    columnGroups(this.metrics(), this.fields(), this.query()),
  );

  private readonly id = `column-picker-${nextColumnPickerId++}`;

  setQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  headingId(groupId: string): string {
    return `${this.id}-${groupId}`;
  }

  isDisabled(column: ColumnPickerColumn): boolean {
    return (
      column.source === 'metric' && this.disabledMetrics().includes(column.id)
    );
  }

  selectY(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.draftY.set(value);
    if (this.panelId()) this.apply(this.axisColumn(), value);
  }

  private apply(column: ColumnPickerColumn, metric: string | null): void {
    const x = asColumnId(column.id);
    const y = column.source === 'field' || !metric || metric === column.id ? null : asColumnId(metric);
    const graph = this.injector.get(Graph);
    const id = this.panelId();
    if (id) graph.dispatch({ t: 'patchPanel', id, patch: { x, y } });
    else graph.dispatch({ t: 'addPanel', x, y });
  }

  pick(column: ColumnPickerColumn, event?: MouseEvent): void {
    if (!this.isDisabled(column)) {
      if (this.drawer()) {
        this.apply(column, this.draftY() ?? this.y());
        if (!event?.shiftKey) this.closed.emit();
      }
      this.picked.emit(column.id);
    }
  }
}
