import type { QueryKey } from '@mriqc/shared';
import { EMPTY, Observable, Subject, defer, from, merge, of, queueScheduler } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  finalize,
  groupBy,
  map,
  mergeMap,
  observeOn,
  pairwise,
  retry,
  shareReplay,
  startWith,
  switchMap,
  take,
  takeUntil,
  tap,
  withLatestFrom,
} from 'rxjs/operators';
import { queryKey, runQuery, type Api, type Query, type StudyApi } from '../api/api';
import type { State } from '../graph/state';
import type { Command } from '../slices/commands';
import { neededQueries } from '../slices/history/queries';
import { panelQueries } from '../slices/panels/queries';
import { describe } from './errors';

export interface NeededEmission {
  version: string | null;
  queries: ReadonlyMap<QueryKey, Query>;
}

interface Descriptor {
  id: string;
  queries: ReadonlyMap<QueryKey, Query>;
}
interface Frame extends NeededEmission { panels: readonly Descriptor[] }
export const VERSION_RETRY_MS = 2000;

/** Range-bearing queries appear only once the base cohort results determine
 * their shared grid. This stream covers distribution, binned and 2D ranges.
 */
export function sharedRanges(state$: Observable<State>) {
  return state$.pipe(
    map(state => new Map(state.panels.map(panel => [panel.id,
      new Map(panelQueries(state, panel).filter(query => 'range' in query)
        .map(query => [queryKey(query), query])),
    ]))),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}

/** The same snapshot supplies panel descriptors and their shared-range stage. */
function frames(state$: Observable<State>): Observable<Frame> {
  const snapshots = state$.pipe(shareReplay({ bufferSize: 1, refCount: true }));
  return snapshots.pipe(
    withLatestFrom(sharedRanges(snapshots)),
    map(([state, ranges]): Frame => {
      const queries = neededQueries(state);
      const owned = new Set<QueryKey>();
      const panels = state.panels.map(panel => {
        const own = new Map<QueryKey, Query>();
        for (const query of panelQueries(state, panel)) {
          const key = queryKey(query);
          if (!queries.has(key)) continue;
          const resolved = 'range' in query ? ranges.get(panel.id)?.get(key) : query;
          if (resolved) { own.set(key, resolved); owned.add(key); }
        }
        return { id: `panel:${panel.id}`, queries: own };
      });
      // Catalog and export counts have no panel owner. Prefixes prevent a
      // user-authored panel id from colliding with these session requests.
      panels.push({ id: 'session', queries: new Map([...queries].filter(([key]) => !owned.has(key))) });
      return { version: state.dataVersion, queries, panels };
    }),
  );
}

function sameDescriptor(a: { version: string; descriptor: Descriptor | null }, b: { version: string; descriptor: Descriptor | null }): boolean {
  if (a.version !== b.version) return false;
  const left = a.descriptor?.queries, right = b.descriptor?.queries;
  return left === right || !!left && !!right && left.size === right.size && [...left.keys()].every(key => right.has(key));
}

/** Panel changes switch subscriptions; the request pool preserves a shared
 * key while any descriptor still needs it. Its cancellation operator watches
 * the whole frame, so overlapping descriptors never abort each other's work.
 * The pool is effect bookkeeping, not another store or state fold.
 */
function fetchDescriptors(input$: Observable<Frame>, api: Api, studyApi?: StudyApi): Observable<Command> {
  return defer(() => {
    const stop = new Subject<void>();
    const requests = new Map<string, { stream: Observable<Command>; cancel: Subject<void> }>();
    const delivered = new WeakSet<Command>();
    let latest: Frame;
    const ready = input$.pipe(
      filter(frame => frame.version !== null),
      tap(frame => {
        latest = frame;
        const live = new Set([...frame.queries.keys()].map(key => JSON.stringify([frame.version, key])));
        for (const [id, request] of requests) if (!live.has(id)) {
          request.cancel.next();
          request.cancel.complete();
          requests.delete(id);
        }
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const fetch = (key: QueryKey, query: Query, version: string): Observable<Command> => {
      // A synchronous result can re-enter the fold while an older frame is
      // still being enumerated. It must not start superseded work afterwards.
      if (latest.version !== version || !latest.queries.has(key)) return EMPTY;
      const id = JSON.stringify([version, key]);
      let request = requests.get(id);
      if (!request) {
        const cancel = new Subject<void>();
        const stream = defer(() => runQuery(api, query, studyApi)).pipe(
          take(1),
          map((result): Command => ({ t: 'dataArrived', key, result, version })),
          catchError((error: unknown) => of<Command>({ t: 'dataFailed', key, error: describe(error) })),
          takeUntil(cancel),
          takeUntil(stop),
          // Keep a needed request alive across switchMap's unsubscribe/subscribe
          // hand-off. The two takeUntil operators bound every source lifetime.
          shareReplay({ bufferSize: 1, refCount: false }),
        );
        request = { stream, cancel };
        requests.set(id, request);
      }
      return request.stream;
    };
    return ready.pipe(
      startWith(null as Frame | null),
      pairwise(),
      mergeMap(([previous, frame]) => {
        if (!frame) return EMPTY;
        const ids = new Set(frame.panels.map(panel => panel.id));
        return from([
          ...frame.panels.map(descriptor => ({ id: descriptor.id, descriptor, version: frame.version!, frame })),
          ...(previous?.panels ?? []).filter(panel => !ids.has(panel.id))
            .map(panel => ({ id: panel.id, descriptor: null, version: frame.version!, frame })),
        ]);
      }),
      // Synchronous fetchers can feed back immediately. Queue notifications in
      // the same turn to bound stack depth, then discard superseded frames.
      observeOn(queueScheduler),
      filter(event => event.frame === latest),
      groupBy(event => event.id, { duration: group => group.pipe(filter(event => event.descriptor === null)) }),
      mergeMap(group => group.pipe(
        map(({ descriptor, version }) => ({ descriptor, version })),
        distinctUntilChanged(sameDescriptor),
        switchMap(({ descriptor, version }) => descriptor
          ? from(descriptor.queries).pipe(mergeMap(([key, query]) => fetch(key, query, version)))
          : EMPTY),
      )),
      // A shared response is the same object for every subscriber and enters
      // the command loop once, even when the caller does not feed it back.
      filter(command => {
        if (delivered.has(command)) return false;
        delivered.add(command);
        return true;
      }),
      finalize(() => { stop.next(); stop.complete(); requests.clear(); }),
    );
  });
}

function versions(api: Api): Observable<Command> {
  return api.dataVersion().pipe(
    map((version): Command => ({ t: 'dataVersionChanged', version })),
    retry({ delay: VERSION_RETRY_MS }),
  );
}

/** Production edge: population and WASM descriptors use the same operators. */
export function runQueryEffects(state$: Observable<State>, api: Api, studyApi?: StudyApi): Observable<Command> {
  return merge(versions(api), fetchDescriptors(frames(state$), api, studyApi));
}

/** The existing needed-map contract, retained for callers and its regression
 * suite. It uses the same operator pipeline with one owner per query key.
 */
export function runEffects(needed$: Observable<NeededEmission>, api: Api, studyApi?: StudyApi): Observable<Command> {
  return merge(versions(api), fetchDescriptors(needed$.pipe(map(emission => ({
    ...emission,
    panels: [...emission.queries].map(([key, query]) => ({ id: key, queries: new Map([[key, query]]) })),
  }))), api, studyApi));
}
