/**
 * The reducer: `(state, command) => state`, pure, and the only writer of state.
 *
 * Every rule under "Reducer behaviour worth stating" in
 * `docs/dashboard-graph.md` is applied here -- which command changes what, in
 * what order, and what has to be evicted or pruned afterwards. The rules
 * themselves live beside the thing they are rules about: `panels.ts` for a
 * panel's shape, `cohorts.ts` for a cohort's, `filters.ts` for a filter list,
 * `datasets.ts` for the entries map, `url.ts` for anything that arrived from a
 * link. This file is the fold.
 */

import {
type State
} from '../../graph/state';
import { type Command } from '../../loop/commands';

export function reduceStudy(state: State, command: Command): State {
  switch (command.t) {
    case 'studyChosen':
      return { ...state, study: { status: 'loading' } };


    case 'studyLoaded': {
      let loaded: State = {
        ...state,
        study: {
          status: 'ready',
          name: command.name,
          rows: command.rows,
          metrics: command.metrics,
          totalMetrics: command.totalMetrics,
          ignoredColumns: command.ignoredColumns,
          missingMetrics: command.missingMetrics,
          ...(command.columns ? { columns: command.columns } : {}),
          ...(command.columnMapping ? { columnMapping: command.columnMapping } : {}),
        },
      };
      return loaded;
    }


    case 'studyFailed':
      return { ...state, study: { status: 'error', error: command.error } };


    case 'clearStudy': return state.study === 'none' ? state : { ...state, study: 'none' };

    case 'openExport':
      return { ...state, exportDialogOpen: true, exportPanelId: command.panelId };


    case 'requestExport':
      return { ...state, export: { status: 'running', rows: 0, request: {
        ...state.global, columns: command.columns, format: command.format ?? 'arrow',
        selections: state.selections.map(({ metric, range }) => ({ metric, range })),
      } } };


    case 'exportProgress':
      return typeof state.export === 'object' && state.export.status === 'running'
        ? { ...state, export: { ...state.export, rows: command.rows } }
        : state;


    case 'exportFinished':
      return { ...state, export: 'idle' };


    case 'cancelExport':
      return { ...state, export: 'idle', exportDialogOpen: false };


    case 'exportFailed':
      return { ...state, export: { status: 'error', error: command.error } };
    default: return state;
  }
}
