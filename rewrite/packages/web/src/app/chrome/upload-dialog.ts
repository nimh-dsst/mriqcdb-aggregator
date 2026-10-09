import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import type { StudyState } from '../graph/state';

type ReadyStudy = Extract<StudyState, { status: 'ready' }>;

@Component({
  selector: 'app-upload-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="study-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="study-dialog-heading"
      (keydown.escape)="closed.emit()"
      (click)="closeOnBackdrop($event)"
    >
      <div class="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-surface text-ink shadow-xl">
        <header class="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="study-dialog-heading" class="text-lg font-semibold">Add my study</h2>
          <button
            type="button"
            class="rounded px-2 py-1 text-xl leading-none hover:bg-black/5"
            data-testid="study-close"
            aria-label="Close study upload"
            (click)="closed.emit()"
          >×</button>
        </header>

        <div class="space-y-4 overflow-y-auto p-5">
          <label class="flex items-center gap-2 text-sm">
            <input #addAll type="checkbox" [checked]="addToAll()" (change)="addToAll.set(addAll.checked)" />
            <span>Add my study to all cards</span>
          </label>

          <p class="text-sm">CSV, TSV, or a zip of MRIQC JSON files. Rows stay in this browser and are not included in shared links.</p>
          <label class="block text-sm font-medium" for="study-file">Study file</label>
          <input
            #fileInput
            id="study-file"
            data-testid="study-file"
            type="file"
            accept=".csv,.tsv,.zip,text/csv,text/tab-separated-values,application/zip"
            class="block w-full rounded border border-border bg-surface px-3 py-2 text-sm"
            (change)="chooseFile($event, fileInput)"
          />

          @if (selectedFilename()) {
            <p class="text-sm" data-testid="study-selected-file">{{ selectedFilename() }}</p>
          }
          @if (isLoading()) {
            <p data-testid="study-loading" class="text-sm" role="status">Loading study…</p>
          }
          @if (errorMessage(); as message) {
            <p data-testid="study-error" class="text-sm text-danger" role="alert">{{ message }}</p>
          }

          @if (readyStudy(); as ready) {
            <div data-testid="study-ready" class="space-y-4 rounded border border-border p-4">
              <div class="text-sm">
                <p class="font-medium">{{ ready.name }}</p>
                <p>{{ ready.rows }} scans</p>
                <p>{{ ready.metrics.length }} of {{ ready.totalMetrics }} metrics matched</p>
              </div>

              <div>
                <h3 class="text-sm font-medium">Matched metrics</h3>
                <ul class="list-inside list-disc text-sm">
                  @for (metric of ready.metrics; track metric) {
                    <li>{{ metric }}</li>
                  }
                </ul>
              </div>

              @if (mappings(ready).length) {
                <details data-testid="study-mapping">
                  <summary class="cursor-pointer text-sm font-medium">Column mapping</summary>
                  <ul class="list-inside list-disc text-sm">
                    @for (mapping of mappings(ready); track mapping.source + mapping.target) {
                      <li>{{ mapping.source }} → {{ mapping.target }}</li>
                    }
                  </ul>
                </details>
              }

              @if (ignoredColumns(ready).length) {
                <details data-testid="study-ignored">
                  <summary class="cursor-pointer text-sm font-medium">Unmatched columns</summary>
                  <ul class="list-inside list-disc text-sm">
                    @for (column of ignoredColumns(ready); track column) {
                      <li>{{ column }}</li>
                    }
                  </ul>
                </details>
              }
            </div>
          }
        </div>
      </div>
    </section>
  `,
})
export class UploadDialogComponent {
  readonly study = input<StudyState>('none');
  readonly chosen = output<{ file: File; addToAll: boolean }>();
  readonly closed = output<void>();
  readonly selectedFilename = signal('');
  readonly addToAll = signal(true);

  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  readonly isLoading = (): boolean => {
    const value = this.study();
    return typeof value === 'object' && value.status === 'loading';
  };

  readonly readyStudy = (): ReadyStudy | undefined => {
    const value = this.study();
    return typeof value === 'object' && value.status === 'ready' ? value : undefined;
  };

  readonly errorMessage = (): string | undefined => {
    const value = this.study();
    if (typeof value === 'object' && value.status === 'error') {
      return value.error;
    }
    return undefined;
  };

  chooseFile(event: Event, inputElement: HTMLInputElement): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.selectedFilename.set(file.name);
    this.chosen.emit({ file, addToAll: this.addToAll() });
    inputElement.value = '';
  }

  mappings(ready: ReadyStudy): readonly { source: string; target: string }[] {
    return ready.columnMapping ?? [];
  }

  ignoredColumns(ready: ReadyStudy): readonly string[] {
    return ready.ignoredColumns;
  }
}
