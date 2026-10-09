/** Pure feature transitions; foreign commands preserve state identity. */

import { type State } from '../../graph/state';
import { type Command } from '../commands';
import { evict, touch } from './datasets';
import { CATALOG_KEY } from './results';

export function reduceHistory(state: State, command: Command): State {
  switch (command.t) {
    case 'dataArrived': {
      const existing = state.datasets[command.key];
      // An entry already at the current version outranks an arrival tagged with
      // any other version: that arrival is from a superseded fetch.
      if (
        existing &&
        existing.version === state.dataVersion &&
        existing.version !== command.version
      ) {
        return state;
      }
      const datasets = touch(state.datasets, command.key, {
        status: 'ready',
        version: command.version,
        result: command.result,
      });
      const catalog =
        command.key === CATALOG_KEY ? (command.result as State['catalog']) : state.catalog;
      return { ...state, datasets, catalog };
    }


    case 'dataFailed': {
      const version = state.dataVersion ?? '';
      const existing = state.datasets[command.key];
      if (existing && existing.status === 'ready' && existing.version === version) return state;
      return {
        ...state,
        datasets: touch(state.datasets, command.key, {
          status: 'error',
          version,
          error: command.error,
        }),
      };
    }


    case 'retryKey': {
      if (state.datasets[command.key] === undefined) return state;
      const datasets = { ...state.datasets };
      delete datasets[command.key];
      return { ...state, datasets };
    }


    case 'dataVersionChanged':
      return state.dataVersion === command.version
        ? state
        : { ...state, dataVersion: command.version };

    /* ------------------------------------------------------------------ study */


    case 'hydrate': return { ...state, notice: command.notice ?? (command.url.panels.some(panel => panel.series.some(series => series.kind === 'study')) ? 'This view compared against a study that is not in the link.' : null) };
    case 'evictDatasets': return command.panelsBefore === state.panels || command.selectionsBefore === state.selections ? state : evict(state);
    case 'dropStudyDatasets': {
      const entries = Object.entries(state.datasets).filter(([key]) => !key.startsWith('study/'));
      return entries.length === Object.keys(state.datasets).length ? state : { ...state, datasets: Object.fromEntries(entries) };
    }
    default: return state;
  }
}
