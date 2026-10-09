import { brushable } from '../panels/shapes';
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

import { canonicalViewFor, viewsFor } from '@mriqc/shared';
import { type State } from '../../graph/state';
import { type Command } from '../commands';
import { sameFilters, validFilters } from './model';
import { pruneSelection } from './selections';

export function reduceFilters(state: State, command: Command): State {
  switch (command.t) {
    case 'resetSelections': return { ...state, selections: [] };
    case 'setModality': {
      const modality = command.modality;
      if (modality === state.global.modality) return state;
      const views = viewsFor(modality).map(v => v.id);
      const view = views.includes(state.global.view) ? state.global.view : canonicalViewFor(modality);
      return { ...state, global: { modality, view, filters: [] } };
    }

    case 'setView': {
      const view = command.view;
      if (view === state.global.view) return state;
      const { modality } = state.global;
      if (!viewsFor(modality).some(v => v.id === view)) return state;
      return { ...state, global: { ...state.global, view, filters: validFilters(state.global.filters, modality, view) } };
    }

    case 'setFilters': {
      const { modality, view } = state.global;
      const filters = validFilters(command.filters, modality, view);
      // The reducer is the single equality check: the form sources resend the
      // whole control value on every change, and a filter list that did not
      // change must leave the state reference alone or every unrelated keystroke
      // would re-derive the dashboard.
      if (sameFilters(filters, state.global.filters)) return state;
      return ({ ...state, global: { ...state.global, filters } });
    }

    /* ---------------------------------------------------------------- panels */


    case 'clearSelections':
      return state.selections.length ? ({ ...state, selections: [] }) : state;

    case 'brush2d':

    case 'brush': {
      const origin = state.panels.find(panel => panel.id === command.from);
      const metrics = command.t === 'brush' ? [command.metric] : [command.x, command.y];
      const ranges = command.t === 'brush' ? (command.range ? [command.range] : null)
        : command.ranges ? [command.ranges.x, command.ranges.y] : null;
      if (ranges === null) {
        const selections = state.selections.filter(selection => !metrics.includes(selection.metric));
        return selections.length === state.selections.length ? state : ({ ...state, selections });
      }
      if (!origin || !brushable(origin) ||
          origin.x !== metrics[0] || (command.t === 'brush2d' && origin.y !== metrics[1]) ||
          ranges.some(range => !range.every(Number.isFinite))) return state;
      const replacements = metrics.map((metric, i) => ({ from: command.from, metric,
        range: [...ranges[i]].sort((a, b) => a - b) as [number, number] }));
      const selections = [...state.selections.filter(selection => !metrics.includes(selection.metric)), ...replacements];
      if (selections.length > 4) return { ...state, notice: 'Up to four metric ranges can be brushed. Clear a range first.' };
      if (JSON.stringify(selections) === JSON.stringify(state.selections)) return state;
      return ({ ...state, selections, notice: null });
    }

    /* -------------------------------------------------------------------- url */


    case 'hydrateFilters': return { ...state, global: command.url.global, selections: command.url.selections };
    case 'dropPanelSelections': return { ...state, selections: state.selections.filter(selection => selection.from !== command.id) };
    case 'pruneSelections': return command.panelsBefore === state.panels ? state : pruneSelection(state);
    default: return state;
  }
}
