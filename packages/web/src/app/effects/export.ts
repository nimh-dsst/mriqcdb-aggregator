import type { Table } from 'apache-arrow';
import { EMPTY, Observable } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import type { ExportRequest, State } from '../graph/state';
import type { Command } from '../slices/commands';
import { describe } from './errors';

/** RFC 4180 cells, including embedded quotes and newlines. */
export function tableCsv(table: Table): string {
  const cell = (value: unknown): string => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const names = table.schema.fields.map(field => field.name);
  return [names.map(cell).join(','), ...Array.from(table, row =>
    names.map(name => cell(row[name])).join(','))].join('\r\n') + '\r\n';
}

/** Stream batches for row progress while retaining the original Arrow download. */
export function exportRows(request: ExportRequest, fetcher: typeof fetch = fetch): Observable<Command> {
  return new Observable(subscriber => {
    const controller = new AbortController();
    const run = async () => {
      const params = new URLSearchParams({ modality: request.modality, view: request.view,
        filters: JSON.stringify(request.filters), selections: JSON.stringify(request.selections),
        columns: request.columns.join(',') });
      const response = await fetcher(`/export?${params}`, { signal: controller.signal });
      if (!response.ok) {
        const message = await response.text();
        let error = message;
        try { const parsed = JSON.parse(message); error = parsed.error?.message ?? parsed.error ?? parsed.message ?? message; } catch { /* Plain server messages are also valid. */ }
        throw new Error(String(error || `Export failed (${response.status})`));
      }
      if (!response.body) throw new Error('The export response has no stream');
      const { RecordBatchReader, Table } = await import('apache-arrow');
      if (controller.signal.aborted) return;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const stream = response.body.getReader();
      async function* bytes() {
        try {
          while (!controller.signal.aborted) {
            const next = await stream.read();
            if (next.done) break;
            const chunk = new Uint8Array(next.value);
            chunks.push(chunk);
            yield chunk;
          }
        } finally {
          await stream.cancel().catch(() => undefined);
          stream.releaseLock();
        }
      }
      const reader = await RecordBatchReader.from(bytes());
      let rows = 0;
      const batches = [];
      for await (const batch of reader) {
        if (controller.signal.aborted) return;
        rows += batch.numRows;
        if (request.format === 'csv') batches.push(batch);
        subscriber.next({ t: 'exportProgress', rows });
      }
      if (controller.signal.aborted) return;
      const blob = request.format === 'csv'
        ? new Blob([tableCsv(new Table(reader.schema, batches))], { type: 'text/csv;charset=utf-8' })
        : new Blob(chunks, { type: 'application/vnd.apache.arrow.stream' });
      subscriber.next({ t: 'exportFinished', blob, rows,
        filename: `mriqc-${request.modality}-${request.view}.${request.format}` });
      subscriber.complete();
    };
    void run().catch(error => {
      if (!controller.signal.aborted) subscriber.next({ t: 'exportFailed', error: describe(error) });
      subscriber.complete();
    });
    return () => controller.abort();
  });
}

/** A request snapshot is stable across progress commands; cancellation clears it. */
export function runExportEffects(state$: Observable<State>, fetcher: typeof fetch = fetch): Observable<Command> {
  return state$.pipe(
    map(state => typeof state.export === 'object' && state.export.status === 'running'
      ? state.export.request : undefined),
    distinctUntilChanged(),
    switchMap(request => request ? exportRows(request, fetcher) : EMPTY),
  );
}

export function downloadExport(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
