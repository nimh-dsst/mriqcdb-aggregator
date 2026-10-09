import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { asColumnId, type FieldDef, type MetricDef } from '@mriqc/shared';

import type { Command } from '../loop/commands';
import { Graph } from '../loop/graph';

type QuestionId = 'distribution' | 'by' | 'time' | 'relate' | 'uploads';

interface Question {
  readonly id: QuestionId;
  /** The sentence, with {metric}, {second} and {field} where the pickers go. */
  readonly parts: readonly string[];
}

/**
 * The questions people arrive with, each a sentence with blanks. Filling the
 * blanks picks the axes, the form and the split, so nobody has to translate
 * "is motion worse on Siemens?" into x, y, form and series themselves.
 */
const QUESTIONS: readonly Question[] = [
  { id: 'distribution', parts: ['How is', '{metric}', 'distributed?'] },
  { id: 'by', parts: ['How does', '{metric}', 'differ by', '{field}', '?'] },
  { id: 'time', parts: ['How has', '{metric}', 'changed over time?'] },
  { id: 'relate', parts: ['How does', '{metric}', 'relate to', '{second}', '?'] },
  { id: 'uploads', parts: ['How many scans came in over time, by', '{fieldOrAll}', '?'] },
];

@Component({
  selector: 'app-question-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="space-y-2" aria-label="What do you want to see?">
      <h2 class="text-control font-medium text-ink">What do you want to see?</h2>
      <ul class="space-y-1">
        @for (question of questions; track question.id) {
          <li>
            <div class="flex flex-wrap items-center gap-1 rounded border px-2 py-1 text-control text-ink"
              [class.border-highlight]="chosen() === question.id" [class.bg-highlight-soft]="chosen() === question.id" [class.text-highlight-soft-ink]="chosen() === question.id"
              [class.border-border]="chosen() !== question.id"
              (click)="chosen.set(question.id)" data-testid="question">
              @for (part of question.parts; track $index) {
                @switch (part) {
                  @case ('{metric}') {
                    <select class="min-h-8 max-w-56 rounded border border-border bg-surface px-1" aria-label="Metric"
                      [value]="metric()" (change)="metricChoice.set($any($event.target).value)" (focus)="chosen.set(question.id)">
                      @for (family of families(); track family.name) {
                        <optgroup [label]="family.name">
                          @for (item of family.metrics; track item.id) {
                            <option [value]="item.id" [selected]="item.id === metric()">{{ item.label }}</option>
                          }
                        </optgroup>
                      }
                    </select>
                  }
                  @case ('{second}') {
                    <select class="min-h-8 max-w-56 rounded border border-border bg-surface px-1" aria-label="Second metric"
                      [value]="second()" (change)="secondChoice.set($any($event.target).value)" (focus)="chosen.set(question.id)">
                      @for (family of families(); track family.name) {
                        <optgroup [label]="family.name">
                          @for (item of family.metrics; track item.id) {
                            <option [value]="item.id" [selected]="item.id === second()" [disabled]="item.id === metric()">{{ item.label }}</option>
                          }
                        </optgroup>
                      }
                    </select>
                  }
                  @case ('{field}') {
                    <select class="min-h-8 rounded border border-border bg-surface px-1" aria-label="Group by"
                      [value]="field()" (change)="fieldChoice.set($any($event.target).value)" (focus)="chosen.set(question.id)">
                      @for (item of fields(); track item.id) {
                        <option [value]="item.id" [selected]="item.id === field()">{{ item.label.toLowerCase() }}</option>
                      }
                    </select>
                  }
                  @case ('{fieldOrAll}') {
                    <select class="min-h-8 rounded border border-border bg-surface px-1" aria-label="Uploads by"
                      [value]="uploadsBy()" (change)="uploadsBy.set($any($event.target).value)" (focus)="chosen.set(question.id)">
                      <option value="" [selected]="uploadsBy() === ''">nothing (all scans)</option>
                      @for (item of fields(); track item.id) {
                        <option [value]="item.id" [selected]="item.id === uploadsBy()">{{ item.label.toLowerCase() }}</option>
                      }
                    </select>
                  }
                  @default {
                    <span>{{ part }}</span>
                  }
                }
              }
            </div>
          </li>
        }
      </ul>
      <div class="flex justify-end gap-2">
        <button type="button" class="min-h-9 px-2 text-control text-ink" (click)="closed.emit()">Cancel</button>
        <button type="button" class="min-h-9 rounded border border-highlight px-3 text-control text-ink disabled:opacity-50"
          [disabled]="!ready()" (click)="create()" data-testid="question-create">Show it</button>
      </div>
    </section>
  `,
})
export class QuestionPicker {
  private readonly graph = inject(Graph);

  readonly metrics = input.required<readonly MetricDef[]>();
  readonly fields = input.required<readonly FieldDef[]>();
  readonly closed = output<void>();

  readonly questions = QUESTIONS;
  readonly chosen = signal<QuestionId | null>(null);

  readonly metricChoice = signal<string | null>(null);
  readonly secondChoice = signal<string | null>(null);
  readonly fieldChoice = signal<string | null>(null);
  readonly uploadsBy = signal('');

  // Defaults until someone picks: FD mean, then tSNR as the second metric,
  // and the first groupable field (manufacturer).
  readonly metric = computed(() => this.metricChoice() ?? this.preferred([]));
  readonly second = computed(() => this.secondChoice() ?? this.preferred([this.metric()]));

  /** Motion and signal first: what a reader checks before anything else. */
  private preferred(exclude: readonly string[]): string {
    const ids = this.metrics().map(item => String(item.id)).filter(id => !exclude.includes(id));
    return ['fd_mean', 'tsnr', 'snr', 'cjv'].find(id => ids.includes(id)) ?? ids[0] ?? '';
  }
  readonly field = computed(() => this.fieldChoice() ?? String(this.fields()[0]?.id ?? ''));

  readonly families = computed(() => {
    const groups = new Map<string, MetricDef[]>();
    for (const item of this.metrics()) groups.set(item.family, [...groups.get(item.family) ?? [], item]);
    return [...groups].map(([name, metrics]) => ({ name, metrics }));
  });

  readonly ready = computed(() => {
    switch (this.chosen()) {
      case null: return false;
      case 'relate': return this.metric() !== this.second();
      default: return true;
    }
  });

  /** The addPanel command a filled-in question amounts to. */
  command(): Extract<Command, { t: 'addPanel' }> | null {
    const metric = asColumnId(this.metric());
    switch (this.chosen()) {
      case 'distribution':
        return { t: 'addPanel', x: metric, form: 'histogram' };
      case 'by':
        return { t: 'addPanel', x: metric, form: 'box', series: [{ kind: 'field', field: asColumnId(this.field()) }] };
      case 'time':
        return { t: 'addPanel', x: 'created_at', y: metric, form: 'band' };
      case 'relate':
        return { t: 'addPanel', x: metric, y: asColumnId(this.second()), form: 'heatmap' };
      case 'uploads':
        return { t: 'addPanel', x: 'created_at', form: 'histogram',
          ...(this.uploadsBy() ? { series: [{ kind: 'field' as const, field: asColumnId(this.uploadsBy()) }] } : {}) };
      default:
        return null;
    }
  }

  create(): void {
    const command = this.command();
    if (!command) return;
    this.graph.dispatch(command);
    this.closed.emit();
  }
}
