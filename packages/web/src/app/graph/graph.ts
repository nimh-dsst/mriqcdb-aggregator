import type { Query } from '../api/api';
/**
 * The command loop. One file, by design.
 *
 * ```
 * sources ──map──▶ commands$ ──scan(reduce)──▶ state$ ──map──▶ projections
 *    ▲                                                            │
 *    └──────────── effects runner (fetch) ◀───────────────────────┘
 * ```
 *
 * `state$` is the only root. The two `Subject`s below are channels, not state:
 * one carries UI events that Angular gives us as callbacks rather than as
 * observables, the other carries the runner's results back in. Neither is ever
 * read. Every projection is a single `map` off `state$` guarded by
 * `distinctUntilChanged`, and none of them is recombined with another.
 *
 * Nothing subscribes except the edges: templates (through `toSignal` or the
 * async pipe), the router sync, the form sync, and the effects runner.
 */

import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subject, concat, merge, of } from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  scan,
  shareReplay,
  tap,
} from 'rxjs/operators';
import type { QueryKey } from '@mriqc/shared';
import { API } from '../api/api';
import { aboutView, aboutEquals } from '../about/about-view';
import { StudyRunner } from '../study/study-runner';
import { runClusterEffects } from '../study/cluster-effects';
import {
  buildControlsForm,
  filtersFromForm,
  formFromGlobal,
  sameControls,
  type ControlsValue,
} from '../chrome/controls-form';
import type { Command } from './commands';
import { runEffects, runStudyEffects, runExportEffects, downloadExport, type NeededEmission } from './effects';
import { chrome, chromeEquals, type Chrome } from '../view/chrome-view';
import { LIGHT_THEME, type ChartTheme } from '../panels/specs/palette';
import { panelView, type PanelView } from '../view/panel-view';
import { cohortList, cohortListEquals, type CohortChip } from './cohorts';
import { neededQueries } from './queries';
import { defaultDashboard, initialState, reduce } from './reducer';
import type { GlobalState, Panel, PanelId, State } from './state';
import { URL_PARAM, decodeUrlState, encodeUrlState, urlState } from './url';

function sameKeySets(a: ReadonlyMap<QueryKey, Query>, b: ReadonlyMap<QueryKey, Query>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

/**
 * No source may terminate the fold. An error reaching `commands$` completes
 * `state$` and with it every projection and every edge -- a page that renders
 * whatever it last had and never changes again. A source that throws is
 * resubscribed instead; the reducer and the decoder are written so that nothing
 * should, and this is the guard that keeps "should" from being load-bearing.
 */
function guarded<T>(source: Observable<T>): Observable<T> {
  return source.pipe(catchError((_error, caught) => caught));
}

/**
 * The `s` parameter the address bar is actually showing.
 *
 * The router's `queryParamMap` starts as an empty `BehaviorSubject` and only
 * carries the real URL once the initial navigation has resolved, which can be
 * after this graph is built. Reading `window.location` makes the first hydrate
 * independent of that ordering.
 */
function paramFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(URL_PARAM);
  } catch {
    return null;
  }
}

/**
 * Whether a URL sync replaces the current history entry or pushes a new one.
 *
 * A dashboard change the user made is a place they can come back to, so it
 * pushes. Two syncs must not:
 *
 * - the first one after a `hydrate`, which only writes the canonical `s` for a
 *   state that was just read out of the address bar (an empty or abbreviated
 *   URL becoming the full one is not a step in the user's history);
 * - any sync whose `s` is already what the address bar shows. Back and forward
 *   are exactly this case: the browser has already moved, the resulting
 *   `hydrate` folds to the state that URL encodes, and pushing it would append
 *   the entry we just navigated away from and trap the Back button.
 *
 * Pure, so the decision is testable without a router.
 */
export function urlSyncMode(
  firstSyncAfterHydrate: boolean,
  param: string,
  currentUrlParam: string | null,
): 'replace' | 'push' {
  if (firstSyncAfterHydrate) return 'replace';
  return param === currentUrlParam ? 'replace' : 'push';
}

/* -------------------------------------------------------------------- graph */

/** The dashboard, as one fold over one stream of commands. */
@Injectable({ providedIn: 'root' })
export class Graph {
  private readonly api = inject(API);
  private readonly studyApi = inject(StudyRunner);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** UI events Angular hands us as callbacks. A channel, never read. */
  private readonly ui = new Subject<Command>();
  /** The runner's results coming back in. A channel, never read. */
  private readonly feedback = new Subject<Command>();

  /** The global controls. Bound by the top bar; its `valueChanges` is a source. */
  readonly form = buildControlsForm();

  /** Every command, from every source. */
  readonly commands$: Observable<Command>;

  /** The one root. Everything downstream is a `map` off this. */
  readonly state$: Observable<State>;

  readonly panels$: Observable<readonly Panel[]>;
  readonly chrome$: Observable<Chrome>;
  readonly about$: Observable<ReturnType<typeof aboutView>>;
  /** The cohort chips: the two derived cohorts and then the user's. */
  readonly cohorts$: Observable<readonly CohortChip[]>;

  private readonly panelViews = new Map<string, Observable<PanelView | null>>();

  /**
   * The last `s` we put in the URL. Edge bookkeeping so our own navigation does
   * not come back as a `hydrate`; `undefined` until the first sync, which is
   * what lets an initial empty URL still hydrate the default dashboard.
   */
  private lastUrlParam: string | null | undefined = undefined;

  /** False until a hydrate from the real URL has happened. Guards the URL edge. */
  private hydrated = false;

  /**
   * True from a `hydrate` until the sync it causes. That sync only canonicalises
   * the URL the hydrate came from, so it replaces rather than pushes -- which is
   * also what keeps a back/forward hydrate from re-pushing the entry the browser
   * just left.
   */
  private firstSyncAfterHydrate = true;

  constructor() {
    // One source per control, not three readings of one group snapshot, and no
    // `distinctUntilChanged` on any of them.
    //
    // A per-stream `distinctUntilChanged` is a second memory of what the
    // dashboard shows, and `syncForm` writes the reducer's resets back into the
    // form with `emitEvent: false` without updating it: after a modality switch
    // clears the filters, re-picking the value that memory still holds is
    // swallowed. Reading the whole group has the matching failure in the other
    // direction -- the snapshot that carries a new modality still carries the
    // filters the switch is about to clear, so a `setFilters` built from it
    // undoes the reset one command later.
    //
    // A control that changes emits; nothing else does. Equality is the
    // reducer's job alone: it returns the same state reference for a command
    // that changes nothing, so a duplicate costs one no-op fold.
    const controls = this.form.controls;

    const modality$ = controls.modality.valueChanges.pipe(
      map((modality): Command => ({ t: 'setModality', modality })),
    );

    const view$ = controls.view.valueChanges.pipe(map((view): Command => ({ t: 'setView', view })));

    const filters$ = merge(
      controls.filters.valueChanges,
      controls.numeric.valueChanges,
      controls.createdFrom.valueChanges,
      controls.createdTo.valueChanges,
    ).pipe(
      // The only time operator on this side of the loop: a date typed into the
      // picker, or a bound typed into a range box, is one command rather than
      // one per keystroke.
      debounceTime(150),
      map((): Command => ({ t: 'setFilters', filters: filtersFromForm(this.form.getRawValue()) })),
    );

    // The first emission carries the whole dashboard and comes from the address
    // bar, because the router may not have navigated yet when this is built.
    // Later ones are back and forward navigation, and are only trusted once it
    // has. Our own URL writes are filtered back out by `lastUrlParam`.
    const hydrate$ = concat(
      of(paramFromLocation()),
      this.route.queryParamMap.pipe(
        filter(() => this.router.navigated),
        map((params) => params.get(URL_PARAM)),
      ),
    ).pipe(
      distinctUntilChanged(),
      filter((param) => (param ?? '') !== this.lastUrlParam),
      tap(() => {
        this.hydrated = true;
        this.firstSyncAfterHydrate = true;
      }),
      map((param): Command => {
        const decoded = decodeUrlState(param);
        return { t: 'hydrate', url: decoded ?? defaultDashboard(),
          ...(param && !decoded ? { notice: 'This dashboard URL could not be read. Showing the default dashboard.' } : {}) };
      }),
    );

    this.commands$ = merge(
      guarded(modality$),
      guarded(view$),
      guarded(filters$),
      guarded(hydrate$),
      guarded(this.ui),
      guarded(this.feedback),
    );

    this.state$ = this.commands$.pipe(
      scan(reduce, initialState),
      takeUntilDestroyed(this.destroyRef),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    this.panels$ = this.state$.pipe(
      map((state) => state.panels),
      distinctUntilChanged(),
    );

    this.chrome$ = this.state$.pipe(map(chrome), distinctUntilChanged(chromeEquals));
    this.about$ = this.state$.pipe(map(aboutView), distinctUntilChanged(aboutEquals));

    this.cohorts$ = this.state$.pipe(map(cohortList), distinctUntilChanged(cohortListEquals));

    const needed$: Observable<NeededEmission> = this.state$.pipe(
      map((state) => ({ version: state.dataVersion, queries: neededQueries(state) })),
      distinctUntilChanged((a, b) => a.version === b.version && sameKeySets(a.queries, b.queries)),
    );

    // Edge 1: the effects runner. Its output is the feedback channel.
    runEffects(needed$, this.api, this.studyApi)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (command) => this.feedback.next(command),
        // The runner isolates its own sources; this is the last stop, so an
        // error here must not reach the feedback channel and the fold.
        error: () => undefined,
      });

    runExportEffects(this.state$).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(command => {
      this.feedback.next(command);
      if (command.t === 'exportFinished' && command.blob && command.filename) {
        downloadExport(command.blob, command.filename);
      }
    });

    runStudyEffects(this.ui, this.studyApi)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (command) => this.feedback.next(command),
        error: () => undefined,
      });

    runClusterEffects(this.state$).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: command => this.feedback.next(command), error: () => undefined,
    });

    // Edge 2: the URL. `urlState` excludes datasets and cursors.
    this.state$
      .pipe(
        map(urlState),
        map(encodeUrlState),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((param) => this.syncUrl(param));

    // Edge 3: the controls form, pushed back when the reducer changes `global`
    // (a modality switch clears filters). `emitEvent: false` keeps it an edge.
    this.state$
      .pipe(
        map((state) => state.global),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((global) => this.syncForm(global));

    // Keep the fold alive for the life of the injector, so a panel appearing
    // later replays the current state instead of restarting the dashboard.
    this.state$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  /** Panel toolbars, the Vega directive, and the "+ panel" menu come in here. */
  dispatch(command: Command): void {
    this.ui.next(command);
  }

  /** The view for one panel. One observable per id, so templates can hold it. */
  panelView$(id: PanelId, theme: ChartTheme = LIGHT_THEME): Observable<PanelView | null> {
    const key = `${id}/${theme.mode}`;
    const existing = this.panelViews.get(key);
    if (existing) return existing;
    const view$ = this.state$.pipe(
      map((state) => panelView(state, id, theme)),
      distinctUntilChanged(),
      // Panel ids can arrive from a URL, so the memo table is unbounded unless
      // an id drops out of it when its last subscriber -- the card -- goes.
      finalize(() => this.panelViews.delete(key)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.panelViews.set(key, view$);
    return view$;
  }

  private syncUrl(param: string): void {
    // Never before the first hydrate: writing the URL from a state that has not
    // yet read the address bar is how a shared link gets replaced by the
    // default dashboard on arrival.
    if (!this.hydrated) return;
    if (this.lastUrlParam === param) return;
    const mode = urlSyncMode(this.firstSyncAfterHydrate, param, paramFromLocation());
    this.firstSyncAfterHydrate = false;
    this.lastUrlParam = param;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [URL_PARAM]: param || null },
      queryParamsHandling: 'merge',
      replaceUrl: mode === 'replace',
    });
  }

  private syncForm(global: GlobalState): void {
    const wanted = formFromGlobal(global);
    const current = this.form.getRawValue() as ControlsValue;
    if (sameControls(wanted, current)) return;
    this.form.setValue(wanted, { emitEvent: false });
  }
}
