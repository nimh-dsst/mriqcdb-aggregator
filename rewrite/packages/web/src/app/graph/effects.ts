import type { Query } from '../api/api';
/**
 * The effects runner: the only asynchronous thing in the application, and the
 * only way anything re-enters the loop.
 *
 * It consumes `needed$` and diffs successive emissions. A key that appears
 * starts one fetch; a key that disappears cancels it. That is the entire
 * cancellation story (`docs/dashboard-graph.md`, "Outputs"). Results become
 * `dataArrived` or `dataFailed` commands. The runner holds no state: the diff
 * lives in a `scan`-free `pairwise`, and nothing here can be read by anyone.
 */

import { EMPTY, Observable, from, merge, of } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  map,
  mergeMap,
  pairwise,
  retry,
  shareReplay,
  startWith,
  switchMap,
  take,
  takeUntil,
} from 'rxjs/operators';
import type { QueryKey } from '@mriqc/shared';
import type { Command } from './commands';
import { runQuery, type Api, type StudyApi } from '../api/api';
import type { Table } from 'apache-arrow';
import type { ExportRequest, State } from './state';

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

/**
 * One emission of the needed projection: the keys the dashboard wants, with
 * their parameters, tagged with the ingest version they would be fetched at.
 */
export interface NeededEmission {
  version: string | null;
  queries: ReadonlyMap<QueryKey, Query>;
}

/** How long a dropped version subscription waits before reconnecting. */
export const VERSION_RETRY_MS = 2000;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Request failed';
}

/**
 * Wire `needed$` to an `Api` and return the commands that come back.
 *
 * Nothing is fetched until the data version is known: an entry has to be
 * tagged with the version it was fetched at, and tagging it with a guess is
 * how a dashboard ends up showing data it cannot invalidate.
 */
export function runEffects(
  needed$: Observable<NeededEmission>,
  api: Api,
  studyApi?: StudyApi,
): Observable<Command> {
  const ready$ = needed$.pipe(
    filter((emission) => emission.version !== null),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // The diff is over (key, version) pairs, not keys. A key that is still in the
  // set when the ingest version changes has to be fetched again: the in-flight
  // call was tagged with the old version, so its result would satisfy nothing,
  // and a key that never left the set would otherwise never be re-added.
  const added$ = ready$.pipe(
    startWith(null as NeededEmission | null),
    pairwise(),
    mergeMap(([previous, current]) => {
      if (current === null) return EMPTY;
      const version = current.version as string;
      const carried = previous !== null && previous.version === version ? previous.queries : null;
      const added = [...current.queries]
        .filter(([key]) => carried === null || !carried.has(key))
        .map(([key, query]) => ({ key, query, version }));
      return from(added);
    }),
  );

  const fetches$ = added$.pipe(
    mergeMap(({ key, query, version }) => {
      const cancelled$ = ready$.pipe(
        filter((emission) => !emission.queries.has(key) || emission.version !== version),
      );
      return runQuery(api, query, studyApi).pipe(
        take(1),
        map((result): Command => ({ t: 'dataArrived', key, result, version })),
        catchError((error: unknown) =>
          of<Command>({ t: 'dataFailed', key, error: describe(error) }),
        ),
        takeUntil(cancelled$),
      );
    }),
  );

  // The version subscription is one SSE connection for the whole session, and
  // its error must not reach the merge: that would tear down `fetches$` too and
  // leave the dashboard silently fetching nothing for the rest of the session.
  const versions$ = api.dataVersion().pipe(
    map((version): Command => ({ t: 'dataVersionChanged', version })),
    retry({ delay: VERSION_RETRY_MS }),
  );

  return merge(versions$, fetches$);
}

/** Run file lifecycle commands at the same effects edge as remote queries. */
export function runStudyEffects(
  commands$: Observable<Command>,
  studyApi: StudyApi,
): Observable<Command> {
  return commands$.pipe(
    filter(
      (command): command is Extract<Command, { t: 'studyChosen' | 'clearStudy' }> =>
        command.t === 'studyChosen' || command.t === 'clearStudy',
    ),
    // A newer choice supersedes an older parse/load; clear also cancels it.
    switchMap((command) => {
      if (command.t === 'clearStudy') {
        studyApi.clear();
        return EMPTY;
      }
      return studyApi.load(command.file).pipe(
        map((loaded): Command => ({
          t: 'studyLoaded',
          ...loaded,
          ...(command.addToAll === undefined ? {} : { addToAll: command.addToAll }),
        })),
        catchError((error: unknown) => of<Command>({ t: 'studyFailed', error: describe(error) })),
      );
    }),
  );
}
