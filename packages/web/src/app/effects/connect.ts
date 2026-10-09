import { type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable, Subject } from 'rxjs';
import type { Api, StudyApi } from '../api/api';
import type { State } from '../graph/state';
import type { Command } from '../slices/commands';
import { runClusterEffects } from '../study/cluster-effects';
import { downloadExport, runExportEffects } from './export';
import { runQueryEffects } from './queries';
import { runStudyEffects } from './study';

/** Effect subscriptions are edges; all their results re-enter the same fold. */
export function connectEffects(state$: Observable<State>, ui: Observable<Command>, feedback: Subject<Command>,
  api: Api, studyApi: StudyApi, destroyRef: DestroyRef): void {
  const observer = { next: (command: Command) => feedback.next(command), error: () => undefined };
  // Keep query effects first: the initial hydrate is a cold command source.
  runQueryEffects(state$, api, studyApi).pipe(takeUntilDestroyed(destroyRef)).subscribe(observer);
  runExportEffects(state$).pipe(takeUntilDestroyed(destroyRef)).subscribe(command => {
    feedback.next(command);
    if (command.t === 'exportFinished' && command.blob && command.filename) downloadExport(command.blob, command.filename);
  });
  runStudyEffects(ui, studyApi).pipe(takeUntilDestroyed(destroyRef)).subscribe(observer);
  runClusterEffects(state$).pipe(takeUntilDestroyed(destroyRef)).subscribe(observer);
}
