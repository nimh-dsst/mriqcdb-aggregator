import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subject, merge } from 'rxjs';
import { catchError, distinctUntilChanged, finalize, map, scan, shareReplay } from 'rxjs/operators';
import { connectEffects } from '../effects/connect';

import { aboutEquals, aboutView } from '../about/about-view';
import { API } from '../api/api';
import { buildControlsForm } from '../chrome/controls-form';
import { LIGHT_THEME, type ChartTheme } from '../panels/specs/palette';
import { cohortList, cohortListEquals } from '../slices/cohorts/view';
import { type Command } from '../slices/commands';
import { chrome, chromeEquals } from '../slices/filters/view';
import { panelView } from '../slices/panels/view';
import { initialState, reduce } from '../slices/reducer';
import { StudyRunner } from '../study/study-runner';
import { encodeUrlState, urlState } from '../url/url';

import { UrlSync } from '../effects/url';
import { controlCommands, synchronizeControls } from '../slices/filters/controls';

export { urlSyncMode } from '../slices/history/history';

function guarded<T>(source: Observable<T>): Observable<T> {
  return source.pipe(catchError((_error, caught) => caught));
}

@Injectable({ providedIn: 'root' })
export class Graph {
  private readonly api = inject(API);
  private readonly studyApi = inject(StudyRunner);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly url = new UrlSync(this.router, this.route);
  private readonly panelViews = new Map<
    string,
    Observable<ReturnType<typeof panelView>>
  >();

  private readonly ui = new Subject<Command>();
  private readonly feedback = new Subject<Command>();
  readonly form = buildControlsForm();
  readonly commands$: Observable<Command> = merge(
    guarded(controlCommands(this.form)),
    guarded(this.url.hydrate$),
    guarded(this.ui),
    guarded(this.feedback),
  );

  // Keep all dashboard state transitions in one fold over commands.
  readonly state$ = this.commands$.pipe(
    scan(reduce, initialState),
    takeUntilDestroyed(this.destroyRef),
    shareReplay({ bufferSize: 1, refCount: false }),
  );
  readonly panels$ = this.state$.pipe(
    map((state) => state.panels),
    distinctUntilChanged(),
  );
  readonly chrome$ = this.state$.pipe(
    map(chrome),
    distinctUntilChanged(chromeEquals),
  );
  readonly about$ = this.state$.pipe(
    map(aboutView),
    distinctUntilChanged(aboutEquals),
  );
  readonly cohorts$ = this.state$.pipe(
    map(cohortList),
    distinctUntilChanged(cohortListEquals),
  );

  constructor() {
    this.connectEffects();
  }

  dispatch(command: Command): void {
    this.ui.next(command);
  }

  panelView$(id: string, theme: ChartTheme = LIGHT_THEME) {
    const key = `${id}/${theme.mode}`;
    let view$ = this.panelViews.get(key);
    if (!view$) {
      view$ = this.state$.pipe(
        map((state) => panelView(state, id, theme)),
        distinctUntilChanged(),
        finalize(() => this.panelViews.delete(key)),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.panelViews.set(key, view$);
    }
    return view$;
  }

  private connectEffects(): void {
    connectEffects(this.state$, this.ui, this.feedback, this.api, this.studyApi, this.destroyRef);
    this.state$
      .pipe(
        map(urlState),
        map(encodeUrlState),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((param) => this.url.sync(param));
    synchronizeControls(
      this.form,
      this.state$.pipe(map((state) => state.global)),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
    this.state$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }
}
