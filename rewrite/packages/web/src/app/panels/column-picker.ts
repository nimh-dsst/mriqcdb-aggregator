import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { FieldDef, MetricDef } from '@mriqc/shared';
import { asColumnId } from '@mriqc/shared';
import { Graph } from '../graph/graph';
import type { Form, Aggregate } from '../graph/state';
import { canSwapDrawerSlots, reduceDrawerSlots, type DrawerSlots, type DrawerSlotsAction } from './column-slots';

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
    <div class="column-picker" [class.column-picker-browser]="drawer()" (keydown.escape)="escape($event)">
      @if (drawer()) { <h2 class="sr-only">{{ panelId() ? 'Change panel column' : 'Add a panel' }}</h2> }
      <div class="column-picker-toolbar">
      @if (drawer()) {
        <div class="column-picker-slots" aria-label="Panel quantity">
          @for (slot of slotNames; track slot) {
            <div class="column-picker-slot" [class.slot-focused]="slots().focused === slot">
              <label class="slot-target">
                <span>{{ slot === 'x' ? 'X' : 'Y' }}</span>
                <input type="text" autocomplete="off"
                [attr.aria-label]="slot === 'x' ? 'X slot' : 'Y slot'"
                [attr.cdkFocusInitial]="focusY() && slot === 'y' ? '' : null"
                [value]="editingSlot() === slot ? query() : slots()[slot]?.label || (slot === 'y' ? (quantity() === 'share' ? 'Share' : 'Count') : '')"
                placeholder="Choose a column"
                (focus)="focusSlot(slot)" (click)="focusSlot(slot)"
                (input)="searchSlot(slot, $event)" (keydown)="slotKey(slot, $event)" />
              </label>
              @if (slots()[slot] && (slot === 'y' || !panelId())) {
                <button type="button" class="btn btn-quiet" [attr.aria-label]="'Clear ' + slot.toUpperCase() + ' slot'"
                  (click)="slotAction({ type: 'clear', slot })">✕</button>
              }
            </div>
          }
          <button type="button" class="btn btn-quiet" aria-label="Swap X and Y" [disabled]="!canSwap()" (click)="slotAction({ type: 'swap' })">⇄</button>
          @if (slots().y) {
            <label class="text-caption">Aggregate
              <select aria-label="Aggregate" [value]="selectedAggregate()" (change)="changeAggregate($event)">
                @for (value of aggregates; track value) {
                  <option [value]="value" [disabled]="unavailableAggregate(value)" [title]="unavailableAggregate(value) ? 'not available for this aggregate' : ''">{{ value }}{{ unavailableAggregate(value) ? ' — not available for this aggregate' : '' }}</option>
                }
              </select>
            </label>
          }
        @if (!panelId()) {
          <button type="button" class="btn" [disabled]="!slots().x" (click)="commit($event)">Create panel</button>
        }
        </div>
      }
      @if (!drawer()) {
      <label class="column-picker-search">
        <span class="sr-only">Search columns</span>
        <input
          type="search"
          class="w-full rounded border border-border bg-surface px-2 py-1 text-control text-ink"
          aria-label="Search columns"
          placeholder="Search columns"
          [value]="query()"
          (input)="setQuery($event)"
        />
      </label>
      }
      @if (drawer()) {
        <button type="button" class="btn btn-quiet" aria-label="Close column drawer" (click)="closed.emit()">Close</button>
      }
      </div>

      <div class="column-picker-body">
      @if (drawer()) {
        <nav class="column-picker-families" aria-label="Column families" (keydown)="paneKey('families', $event)">
          @for (family of families(); track family.label) {
            <button type="button" class="column-picker-family-choice" [attr.data-family]="family.label"
              [attr.aria-pressed]="selectedFamily() === family.label"
              [class.no-hits]="!familyHasHits(family.label)"
              (click)="selectFamily(family.label)">
              <span>{{ family.label }}</span><span class="column-picker-count">{{ familyCount(family) }}</span>
            </button>
          }
        </nav>
      }
      <div class="column-picker-columns" aria-label="Columns" tabindex="-1" (keydown)="paneKey('columns', $event)">
      @if (drawer() && slots().focused === 'y') {
        <div class="column-picker-rows" aria-label="Y quantity">
          <button type="button" class="column-picker-row" (click)="chooseQuantity('count')">Count</button>
          <button type="button" class="column-picker-row" (click)="chooseQuantity('share')">Share</button>
        </div>
      }
      @if (visibleGroups().length === 0) {
        <p class="text-caption text-ink-2">No columns match your search.</p>
      }

      @for (group of visibleGroups(); track group.label) {
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
                    [attr.aria-pressed]="drawer() ? column.id === slots().x?.id || column.id === slots().y?.id : column.id === selected()"
                    [disabled]="isDisabled(column)"
                    (mouseenter)="preview.set(column.id)"
                    (focus)="preview.set(column.id)"
                    (click)="pick(column, $event)"
                  >
                    <span>{{ column.label }}</span>
                    <span class="column-picker-short">{{ column.shortLabel }}{{ column.unit ? (column.shortLabel ? ' · ' : '') + column.unit : '' }}</span>
                  </button>
                }
              </div>
            </div>
          }
        </section>
      }
      </div>
      @if (drawer()) {
        <aside class="column-picker-details" aria-label="Column details" tabindex="-1" (keydown)="paneKey('details', $event)">
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
          <ng-content />
        <p class="text-caption">Choose X and Y{{ panelId() ? '.' : ', then create the panel. Hold Shift when creating to keep this drawer open.' }}</p>
        </aside>
      }
      </div>
    </div>
  `,
  styles: `
    .column-picker-slots { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
    .column-picker-slots > .btn { flex-shrink: 0; }
    .column-picker-slot { position: relative; display: flex; flex: 1; align-items: center; border: 1px solid var(--border); border-radius: 6px; min-height: 40px; min-width: 0; }
    .slot-focused { outline: 2px solid var(--action-ink); outline-offset: 1px; }
    .slot-target { display: flex; align-items: center; gap: 8px; padding: 4px 8px; text-align: left; min-width: 0; }
    .slot-target > span:first-child { flex-shrink: 0; }
    .slot-target { flex: 1; }
    .slot-target input { width: 100%; min-width: 0; background: transparent; color: var(--ink); outline: none; }
  `,
})
export class ColumnPicker {
  private readonly injector = inject(Injector);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly metrics = input.required<readonly MetricDef[]>();
  readonly fields = input.required<readonly FieldDef[]>();
  readonly selected = input<string | null>(null);
  readonly disabledMetrics = input<readonly string[]>([]);
  readonly picked = output<string>();
  readonly drawer = input(false);
  readonly focusY = input(false);
  readonly pendingForm = input<Form | null>(null);
  readonly panelId = input<string | null>(null);
  readonly y = input<string | null>(null);
  readonly aggregate = input<Aggregate>('median');
  readonly selectedAggregate = signal<Aggregate>('median');
  readonly quantity = signal<'count' | 'share'>('count');
  readonly aggregates: readonly Aggregate[] = ['median', 'mean', 'sum', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95'];
  unavailableAggregate(value: Aggregate): boolean {
    if (value === 'sum') return true;
    return ['min', 'max'].includes(value) && !(this.slots().x?.source === 'field' && this.slots().y?.source === 'metric');
  }
  changeAggregate(event: Event): void {
    this.selectedAggregate.set((event.target as HTMLSelectElement).value as Aggregate);
    this.applyLive();
  }
  chooseQuantity(value: 'count' | 'share'): void {
    this.quantity.set(value);
    this.slots.update(slots => ({ ...slots, y: null, focused: 'y' }));
    this.applyLive();
  }
  readonly closed = output<void>();
  readonly preview = signal<string | null>(null);
  readonly slotNames = ['x', 'y'] as const;
  readonly slots = signal<DrawerSlots<ColumnPickerColumn & { isNumeric: boolean; isContinuous: boolean }>>({ x: null, y: null, focused: 'x' });
  readonly canSwap = computed(() => canSwapDrawerSlots(this.slots()));
  readonly activeColumn = computed(() => columnGroups(this.metrics(), this.fields(), '')
    .flatMap(group => group.sections.flatMap(section => section.columns))
    .find(column => column.id === (this.preview() ?? this.selected())) ?? uploadTime);
  readonly activeMetric = computed(() => this.metrics().find(metric => metric.id === this.activeColumn().id));
  readonly activeField = computed(() => this.fields().find(field => field.id === this.activeColumn().id));
  private initializedPanel: string | null | undefined;
  private previousFocusY = false;
  constructor() {
    effect(() => {
      // Catalog refreshes must not discard picks in an open drawer. Only the
      // requested panel/axes/focus initialize the slots.
      const columns = untracked(() => columnGroups(this.metrics(), this.fields(), '')).flatMap(group => group.sections.flatMap(section => section.columns));
      const find = (id: string | null) => {
        const column = columns.find(column => column.id === id);
        return column ? this.slotColumn(column) : null;
      };
      const first = this.initializedPanel !== this.panelId();
      this.quantity.set(this.y() === 'share' ? 'share' : 'count');
      this.selectedAggregate.set(this.aggregate());
      const focusChanged = this.previousFocusY !== this.focusY();
      this.slots.set({ x: this.panelId() ? find(this.selected()) : null, y: this.panelId() ? find(this.y()) : null,
        focused: first || focusChanged ? (this.focusY() ? 'y' : 'x') : untracked(this.slots).focused });
      if (first) this.selectedFamily.set(this.panelId() ? find(this.selected())?.family ?? 'Time' : 'Time');
      this.initializedPanel = this.panelId();
      this.previousFocusY = this.focusY();
      this.editingSlot.set(null);
      this.query.set('');
    });
  }

  private slotColumn(column: ColumnPickerColumn) {
    return { ...column, isNumeric: column.source === 'metric', isContinuous: column.source !== 'field' };
  }

  slotAction(action: DrawerSlotsAction<ColumnPickerColumn & { isNumeric: boolean; isContinuous: boolean }>): void {
    if (action.type === 'clear' && action.slot === 'y') this.quantity.set('count');
    this.slots.update(slots => reduceDrawerSlots(slots, action));
    if (action.type !== 'focus') {
      this.query.set('');
      this.editingSlot.set(null);
      this.applyLive();
    }
  }

  readonly query = signal('');
  readonly groups = computed(() =>
    columnGroups(this.metrics(), this.drawer() && this.slots().focused === 'y' ? [] : this.fields(), this.query()),
  );
  readonly families = computed(() => columnGroups(this.metrics(), this.fields(), ''));
  readonly selectedFamily = signal('Time');
  readonly visibleGroups = computed(() => !this.drawer() || this.query().trim()
    ? this.groups() : this.groups().filter(group => group.label === this.selectedFamily()));
  readonly editingSlot = signal<'x' | 'y' | null>(null);
  readonly visibleColumns = computed(() => this.visibleGroups().flatMap(group => group.sections.flatMap(section => section.columns))
    .filter(column => !this.isDisabled(column)));

  familyCount(group: ColumnPickerGroup): number {
    return group.sections.reduce((count, section) => count + section.columns.length, 0);
  }

  familyHasHits(family: string): boolean {
    return this.groups().some(group => group.label === family);
  }

  selectFamily(family: string): void {
    this.selectedFamily.set(family);
    this.query.set('');
    this.editingSlot.set(null);
  }

  focusSlot(slot: 'x' | 'y'): void {
    if (this.slots().focused !== slot) {
      this.query.set('');
      this.editingSlot.set(null);
    }
    this.slotAction({ type: 'focus', slot });
  }

  searchSlot(slot: 'x' | 'y', event: Event): void {
    this.slotAction({ type: 'focus', slot });
    this.editingSlot.set(slot);
    this.setQuery(event);
  }

  escape(event: Event): void {
    if (!this.drawer()) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.query()) {
      this.query.set('');
      this.editingSlot.set(null);
    } else {
      this.closed.emit();
    }
  }

  slotKey(slot: 'x' | 'y', event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = this.element.nativeElement.querySelectorAll<HTMLButtonElement>('.column-picker-columns button:not(:disabled)');
      const next = buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1];
      next?.focus();
      next?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const column = this.visibleColumns()[0];
      if (column) {
        this.slotAction({ type: 'focus', slot });
        this.pick(column);
      }
    } else if (event.key === 'Delete' && !(event.target as HTMLInputElement).value) {
      this.slotAction({ type: 'clear', slot });
    }
  }

  paneKey(pane: 'families' | 'columns' | 'details', event: KeyboardEvent): void {
    if (!this.drawer()) return;
    const target = event.target as HTMLElement;
    if (target.matches('input, select, textarea')) return;
    const root = this.element.nativeElement;
    if (event.key === 'Enter' && pane !== 'details' && target.matches('button:not(:disabled)')) {
      event.preventDefault();
      target.click();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const destination = event.key === 'ArrowRight' ? (pane === 'families' ? 'columns' : 'details')
        : (pane === 'details' ? 'columns' : 'families');
      const container = root.querySelector<HTMLElement>('.column-picker-' + destination);
      const preferred = destination === 'families' ? '[aria-pressed="true"]' : '[data-column-id]:not(:disabled)';
      (container?.querySelector<HTMLElement>(preferred) ?? container)?.focus();
      event.preventDefault();
    } else if (pane !== 'details' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.column-picker-' + pane + ' button:not(:disabled)'));
      const index = buttons.indexOf(target as HTMLButtonElement);
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        if (pane === 'families') this.selectFamily(next.dataset['family']!);
        next.focus();
      }
      event.preventDefault();
    }
  }

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

  commit(event?: MouseEvent): void {
    if (this.panelId()) return;
    const { x: column, y: second } = this.slots();
    if (!column) return;
    const x = asColumnId(column.id);
    const y = !second || second.id === column.id ? this.quantity() : asColumnId(second.id);
    this.injector.get(Graph).dispatch({ t: 'addPanel', x, y, aggregate: this.selectedAggregate() });
    if (!event?.shiftKey) this.closed.emit();
    else this.slots.set({ x: null, y: null, focused: 'x' });
  }

  private applyLive(): void {
    const id = this.panelId();
    if (!id) return;
    const { x: column, y: second } = this.slots();
    if (!column) return;
    const x = asColumnId(column.id);
    const y = !second || second.id === column.id ? this.quantity() : asColumnId(second.id);
    const form = this.pendingForm();
    this.injector.get(Graph).dispatch({ t: 'patchPanel', id, patch: { x, y, aggregate: this.selectedAggregate(), ...(form && second ? { form } : {}) } });
  }

  pick(column: ColumnPickerColumn, event?: MouseEvent): void {
    if (!this.isDisabled(column)) {
      if (this.drawer()) {
        this.slotAction({ type: 'pick', column: this.slotColumn(column) });
        this.selectedFamily.set(column.family);
        this.preview.set(column.id);
      }
      this.picked.emit(column.id);
    }
  }
}
