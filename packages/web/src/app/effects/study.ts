import { EMPTY, Observable, of } from 'rxjs';
import { catchError, filter, map, switchMap } from 'rxjs/operators';
import type { StudyApi } from '../api/api';
import type { Command } from '../slices/commands';
import { describe } from './errors';

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
