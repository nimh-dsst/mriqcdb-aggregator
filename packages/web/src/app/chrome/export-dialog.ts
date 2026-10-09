import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { map } from 'rxjs';
import type { ColumnId } from '@mriqc/shared';
import { Graph } from '../loop/graph';
import { exportView } from './export-view';

@Component({
  selector: 'app-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" (keydown.escape)="cancel()">
      <section role="dialog" aria-modal="true" aria-labelledby="export-title" tabindex="-1"
        class="flex max-h-[85vh] w-full max-w-xl flex-col gap-3 overflow-auto rounded-card border border-border bg-surface p-6" data-testid="export-dialog">
        <h2 id="export-title" class="text-title font-semibold">Export rows</h2>
        <p class="text-caption text-ink-2" data-testid="export-scope">{{ view()?.scope }}</p>
        @if (view()?.study) { <p class="text-caption">Your study is your own file and is not exportable. This export includes population rows only.</p> }
        <div class="flex gap-3">
          <button class="btn btn-quiet" (click)="choose('metrics')" [disabled]="running()">All metrics</button>
          <button class="btn btn-quiet" (click)="choose('all')" [disabled]="running()">All fields</button>
          <button class="btn btn-quiet" (click)="choose('none')" [disabled]="running()">None</button>
        </div>
        <div class="max-h-60 overflow-auto rounded-card border border-border p-3">
          @for (group of view()?.groups ?? []; track group.family) {
            <fieldset class="mb-3" [disabled]="running()"><legend class="field-label">{{ group.family }}</legend>
              <div class="grid grid-cols-2 gap-2">
                @for (field of group.fields; track field.id) {
                  <label class="flex items-start gap-2 text-caption"><input type="checkbox" [checked]="selected().includes(field.id)"
                    (change)="toggle(field.id)" [attr.data-column]="field.id" />{{ field.label }}</label>
                }
              </div>
            </fieldset>
          }
        </div>
        <label class="field-label">Format
          <select class="ml-2 rounded border border-border bg-surface p-2" [value]="format()" (change)="setFormat($event)" [disabled]="running()" data-testid="export-format">
            <option value="arrow">Arrow (.arrow)</option><option value="csv">CSV (.csv)</option>
          </select>
        </label>
        @if (format() === 'csv' && (view()?.rows ?? 0) > 500000) { <p class="text-caption text-ink-2">CSV will be large above 500,000 rows and may take longer to prepare.</p> }
        <p class="text-caption text-ink-2">Estimated size: {{ estimate() }} · {{ selected().length }} columns</p>
        @if (running()) {
          <progress class="w-full" [value]="progress()" [max]="view()?.rows || 1" aria-label="Rows exported"></progress>
          <p role="status" class="text-caption">{{ progress() | number }} rows read</p>
        }
        @if (error(); as message) { <p role="alert" class="text-caption text-danger">{{ message }}</p> }
        <div class="flex justify-end gap-2">
          <button class="btn" (click)="cancel()">{{ running() ? 'Cancel' : 'Close' }}</button>
          <button class="btn btn-amber" [disabled]="running() || selected().length === 0" (click)="start()" data-testid="export-start">Export</button>
        </div>
      </section>
    </div>`,
})
export class ExportDialog {
  private readonly graph = inject(Graph);
  readonly closed = output<void>();
  protected readonly view = toSignal(this.graph.state$.pipe(map(exportView)));
  protected readonly selected = signal<readonly ColumnId[]>(this.view()?.defaults ?? []);
  protected readonly format = signal<'arrow' | 'csv'>('arrow');
  protected readonly running = computed(() => { const value = this.view()?.export; return typeof value === 'object' && value.status === 'running'; });
  protected readonly progress = computed(() => { const value = this.view()?.export; return typeof value === 'object' && value.status === 'running' ? value.rows : 0; });
  protected readonly error = computed(() => { const value = this.view()?.export; return typeof value === 'object' && value.status === 'error' ? value.error : null; });
  protected readonly estimate = computed(() => this.view()?.rows == null ? 'counting rows…' : `about ${((this.view()!.rows! * this.selected().length * (this.format() === 'csv' ? 18 : 10)) / 1e6).toFixed(1)} MB`);
  protected choose(which: 'metrics' | 'all' | 'none'): void { this.selected.set(which === 'none' ? [] : which === 'all' ? this.view()?.columns ?? [] : this.view()?.metrics ?? []); }
  protected toggle(id: ColumnId): void { this.selected.update(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]); }
  protected setFormat(event: Event): void { this.format.set((event.target as HTMLSelectElement).value === 'csv' ? 'csv' : 'arrow'); }
  protected start(): void { this.graph.dispatch({ t: 'requestExport', columns: this.selected(), format: this.format() }); }
  protected cancel(): void { this.graph.dispatch({ t: 'cancelExport' }); this.closed.emit(); }
}
