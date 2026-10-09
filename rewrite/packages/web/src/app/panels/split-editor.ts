import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import {
  fieldValueLabel,
  isNoneValue,
  NONE_FILTER_VALUE,
  type FieldDef,
  type Filter,
  type FilterValue,
  type MetricDef,
  type Selection,
} from '@mriqc/shared';
import { LucideAngularModule, Plus, X } from 'lucide-angular';

import { MAX_BUCKETS, OPEN_BOUND, type Bucket } from '../graph/series';
import { OPEN_HI, OPEN_LO } from '../graph/filters';

interface FieldValue {
  readonly value: string | number | boolean | null;
  readonly n: number;
}

/**
 * One condition while it is being edited. A field condition keeps the values
 * ticked (by their wire text); a metric condition keeps the two bounds as
 * typed, blank meaning open-ended.
 */
interface DraftCondition {
  readonly id: number;
  readonly column: string;
  readonly values: readonly string[];
  readonly lo: string;
  readonly hi: string;
}

interface DraftGroup {
  readonly id: number;
  readonly name: string;
  readonly conditions: readonly DraftCondition[];
}

const wire = (value: string | number | boolean | null): string =>
  String(isNoneValue(value) ? NONE_FILTER_VALUE : value);

let nextId = 1;
const fresh = () => nextId++;

/**
 * The custom split editor: up to five named groups, each the scans matching
 * every one of its conditions. Ticking several values of one field merges
 * them into one group; a metric condition cuts a band out of a number.
 */
@Component({
  selector: 'app-split-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <section class="space-y-3 rounded border border-border bg-surface p-3" aria-label="Custom split">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-control font-medium text-ink">Split into groups</h3>
        <span class="text-caption text-ink-2">A scan lands in a group when it matches every condition there.</span>
      </div>

      @for (group of groups(); track group.id; let g = $index) {
        <div class="space-y-2 rounded border border-border p-2" data-testid="split-group">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 shrink-0 rounded-full" [style.background-color]="colorOf(g)" aria-hidden="true"></span>
            <input
              class="min-h-9 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-control text-ink"
              [value]="group.name"
              [placeholder]="autoName(group) || 'Group ' + (g + 1)"
              aria-label="Group name"
              (input)="rename(group.id, $any($event.target).value)"
            />
            <button type="button" class="inline-flex min-h-9 min-w-9 items-center justify-center text-ink-2"
              [attr.aria-label]="'Remove group ' + (g + 1)" (click)="removeGroup(group.id)">
              <lucide-icon [img]="xIcon" [size]="14" aria-hidden="true" />
            </button>
          </div>

          @for (condition of group.conditions; track condition.id) {
            <div class="space-y-1 pl-4">
              <div class="flex items-center gap-2">
                <select
                  class="min-h-9 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-control text-ink"
                  aria-label="Condition column"
                  [value]="condition.column"
                  (change)="setColumn(group.id, condition.id, $any($event.target).value)"
                >
                  <option value="" disabled>Choose a field or metric…</option>
                  <optgroup label="Fields">
                    @for (field of fields(); track field.id) {
                      <option [value]="field.id" [selected]="field.id === condition.column">{{ field.label }}</option>
                    }
                  </optgroup>
                  <optgroup label="Metrics">
                    @for (metric of metrics(); track metric.id) {
                      <option [value]="metric.id" [selected]="metric.id === condition.column">{{ metric.label }}</option>
                    }
                  </optgroup>
                </select>
                <button type="button" class="inline-flex min-h-9 min-w-9 items-center justify-center text-ink-2"
                  aria-label="Remove condition" (click)="removeCondition(group.id, condition.id)">
                  <lucide-icon [img]="xIcon" [size]="14" aria-hidden="true" />
                </button>
              </div>

              @if (isMetric(condition.column)) {
                <div class="flex items-center gap-2 text-control text-ink">
                  <input class="min-h-9 w-28 rounded border border-border bg-surface px-2" type="number" step="any"
                    placeholder="from (any)" aria-label="From" [value]="condition.lo"
                    (input)="setBound(group.id, condition.id, 'lo', $any($event.target).value)" />
                  <span class="text-ink-2">to</span>
                  <input class="min-h-9 w-28 rounded border border-border bg-surface px-2" type="number" step="any"
                    placeholder="to (any)" aria-label="To" [value]="condition.hi"
                    (input)="setBound(group.id, condition.id, 'hi', $any($event.target).value)" />
                  <span class="text-caption text-ink-2">{{ unitOf(condition.column) }}</span>
                </div>
              } @else if (condition.column) {
                <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto" role="group" [attr.aria-label]="'Values of ' + labelOf(condition.column)">
                  @for (entry of valuesOf(condition.column); track wireOf(entry.value)) {
                    @let ticked = condition.values.includes(wireOf(entry.value));
                    <button type="button"
                      class="min-h-8 rounded border px-2 text-caption"
                      [class.border-highlight]="ticked" [class.bg-highlight-soft]="ticked" [class.text-ink]="ticked"
                      [class.border-border]="!ticked" [class.text-ink-2]="!ticked"
                      [attr.aria-pressed]="ticked"
                      (click)="toggleValue(group.id, condition.id, wireOf(entry.value))">
                      {{ valueLabel(condition.column, entry.value) }} <span class="opacity-70">{{ entry.n.toLocaleString('en-US') }}</span>
                    </button>
                  }
                </div>
              }
            </div>
          }

          <button type="button" class="ml-4 inline-flex min-h-8 items-center gap-1 text-caption text-ink-2"
            (click)="addCondition(group.id)">
            <lucide-icon [img]="plusIcon" [size]="12" aria-hidden="true" /> condition
          </button>
        </div>
      }

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="inline-flex min-h-9 items-center gap-1 rounded border border-border px-2 text-control text-ink disabled:opacity-50"
          [disabled]="groups().length >= maxGroups" (click)="addGroup()">
          <lucide-icon [img]="plusIcon" [size]="14" aria-hidden="true" /> Group
        </button>
        <span class="flex-1"></span>
        @if (problem(); as reason) {
          <span class="text-caption text-ink-2">{{ reason }}</span>
        }
        <button type="button" class="min-h-9 px-2 text-control text-ink" (click)="cancelled.emit()">Cancel</button>
        <button type="button" class="min-h-9 rounded border border-highlight px-3 text-control text-ink disabled:opacity-50"
          [disabled]="problem() !== null" (click)="apply()">Apply split</button>
      </div>
    </section>
  `,
})
export class SplitEditor implements OnInit {
  readonly plusIcon = Plus;
  readonly xIcon = X;
  readonly maxGroups = MAX_BUCKETS;

  readonly fields = input.required<readonly FieldDef[]>();
  readonly metrics = input.required<readonly MetricDef[]>();
  readonly fieldValues = input.required<Readonly<Record<string, readonly FieldValue[]>>>();
  readonly initial = input<readonly Bucket[]>([]);
  readonly colors = input<readonly string[]>([]);

  readonly applied = output<readonly Bucket[]>();
  readonly cancelled = output<void>();

  readonly groups = signal<readonly DraftGroup[]>([]);

  ngOnInit(): void {
    const seeded = this.initial().map((bucket): DraftGroup => ({
      id: fresh(),
      name: bucket.name,
      conditions: [
        ...bucket.filters.flatMap((filter): DraftCondition[] =>
          filter.op === 'in'
            ? [{ id: fresh(), column: filter.field, values: filter.values.map(value => wire(value)), lo: '', hi: '' }]
            : []),
        ...(bucket.selections ?? []).map((selection): DraftCondition => ({
          id: fresh(), column: selection.metric, values: [],
          lo: selection.range[0] <= -OPEN_BOUND ? '' : String(selection.range[0]),
          hi: selection.range[1] >= OPEN_BOUND ? '' : String(selection.range[1]),
        })),
      ],
    }));
    this.groups.set(seeded.length ? seeded : [this.blankGroup(), this.blankGroup()]);
  }

  private blankGroup(): DraftGroup {
    return { id: fresh(), name: '', conditions: [{ id: fresh(), column: '', values: [], lo: '', hi: '' }] };
  }

  private readonly metricIds = computed(() => new Set(this.metrics().map(metric => String(metric.id))));

  isMetric(column: string): boolean {
    return this.metricIds().has(column);
  }

  labelOf(column: string): string {
    return this.fields().find(field => field.id === column)?.label
      ?? this.metrics().find(metric => metric.id === column)?.label
      ?? column;
  }

  unitOf(column: string): string {
    return (this.metrics().find(metric => metric.id === column) as { unit?: string } | undefined)?.unit ?? '';
  }

  valuesOf(column: string): readonly FieldValue[] {
    return [...(this.fieldValues()[column] ?? [])].sort((a, b) => b.n - a.n);
  }

  wireOf(value: string | number | boolean | null): string {
    return wire(value);
  }

  valueLabel(column: string, value: string | number | boolean | null): string {
    return fieldValueLabel(column, value);
  }

  colorOf(index: number): string {
    return this.colors()[index] ?? 'currentColor';
  }

  /** What an unnamed group is called: its conditions, read out. */
  autoName(group: DraftGroup): string {
    return group.conditions.flatMap(condition => {
      if (!condition.column) return [];
      if (this.isMetric(condition.column)) {
        if (!condition.lo && !condition.hi) return [];
        const label = this.labelOf(condition.column);
        return [condition.lo && condition.hi ? `${label} ${condition.lo}–${condition.hi}`
          : condition.lo ? `${label} ≥ ${condition.lo}` : `${label} < ${condition.hi}`];
      }
      if (!condition.values.length) return [];
      const entries = this.valuesOf(condition.column);
      return [condition.values.map(value => {
        const entry = entries.find(item => wire(item.value) === value);
        return this.valueLabel(condition.column, entry ? entry.value : value);
      }).join(' or ')];
    }).join(', ');
  }

  readonly problem = computed<string | null>(() => {
    const groups = this.groups();
    if (!groups.length) return 'Add at least one group.';
    const names = groups.map(group => (group.name.trim() || this.autoName(group)));
    if (names.some(name => !name)) return 'Every group needs a condition.';
    if (new Set(names).size !== names.length) return 'Two groups have the same name.';
    for (const group of groups) {
      for (const condition of group.conditions) {
        if (!condition.column) continue;
        if (this.isMetric(condition.column) && condition.lo && condition.hi && Number(condition.lo) > Number(condition.hi)) {
          return `${this.labelOf(condition.column)}: "from" is above "to".`;
        }
      }
    }
    return null;
  });

  private update(groupId: number, change: (group: DraftGroup) => DraftGroup): void {
    this.groups.update(groups => groups.map(group => group.id === groupId ? change(group) : group));
  }

  private updateCondition(groupId: number, conditionId: number, change: (condition: DraftCondition) => DraftCondition): void {
    this.update(groupId, group => ({
      ...group,
      conditions: group.conditions.map(condition => condition.id === conditionId ? change(condition) : condition),
    }));
  }

  rename(groupId: number, name: string): void {
    this.update(groupId, group => ({ ...group, name }));
  }

  addGroup(): void {
    if (this.groups().length < MAX_BUCKETS) this.groups.update(groups => [...groups, this.blankGroup()]);
  }

  removeGroup(groupId: number): void {
    this.groups.update(groups => groups.filter(group => group.id !== groupId));
  }

  addCondition(groupId: number): void {
    this.update(groupId, group => ({
      ...group,
      conditions: [...group.conditions, { id: fresh(), column: '', values: [], lo: '', hi: '' }],
    }));
  }

  removeCondition(groupId: number, conditionId: number): void {
    this.update(groupId, group => ({ ...group, conditions: group.conditions.filter(condition => condition.id !== conditionId) }));
  }

  setColumn(groupId: number, conditionId: number, column: string): void {
    this.updateCondition(groupId, conditionId, condition => ({ ...condition, column, values: [], lo: '', hi: '' }));
  }

  toggleValue(groupId: number, conditionId: number, value: string): void {
    this.updateCondition(groupId, conditionId, condition => ({
      ...condition,
      values: condition.values.includes(value)
        ? condition.values.filter(item => item !== value)
        : [...condition.values, value],
    }));
  }

  setBound(groupId: number, conditionId: number, bound: 'lo' | 'hi', value: string): void {
    this.updateCondition(groupId, conditionId, condition => ({ ...condition, [bound]: value }));
  }

  /** Drafts become filters: ticked wire text maps back to the catalog's own typed value. */
  apply(): void {
    if (this.problem() !== null) return;
    const buckets = this.groups().flatMap((group): Bucket[] => {
      const selections = group.conditions.flatMap((condition): Selection[] =>
        condition.column && this.isMetric(condition.column) && (condition.lo || condition.hi)
          ? [{
            metric: condition.column as Selection['metric'],
            range: [condition.lo ? Number(condition.lo) : OPEN_LO, condition.hi ? Number(condition.hi) : OPEN_HI],
          }]
          : []);
      const filters = group.conditions.flatMap((condition): Filter[] => {
        if (!condition.column || this.isMetric(condition.column)) return [];
        if (!condition.values.length) return [];
        const entries = this.valuesOf(condition.column);
        const values = condition.values.map((text): FilterValue => {
          const entry = entries.find(item => wire(item.value) === text);
          return (entry && !isNoneValue(entry.value) ? entry.value : text) as FilterValue;
        });
        return [{ field: condition.column as Filter['field'], op: 'in', values }];
      });
      const name = group.name.trim() || this.autoName(group);
      if (!filters.length && !selections.length) return [];
      return [{ name, filters, ...(selections.length ? { selections } : {}) }];
    });
    if (buckets.length) this.applied.emit(buckets);
  }
}
