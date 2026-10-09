/** Pure feature transitions; foreign commands preserve state identity. */

import { type State } from '../../graph/state';
import { type Command } from '../commands';

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
